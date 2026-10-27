//! HTTP for the build downloader (ureq). One request per call – retries, host rotation and the
//! meaning of status codes are in `niobium_core::epic::cdn`.
//!
//! On Windows HTTPS goes through Windows' own TLS and certificate store (native-tls/schannel).

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use niobium_core::epic::cdn::{NetError, Transport};

/// A body read gives up when no byte arrived for this long (the plan's "read timeout 30 s").
/// A slow line that keeps sending is fine, however long the chunk takes.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Bodies are read in pieces this big; Pause/Cancel is checked between them.
const READ_PIECE: usize = 64 << 10;

pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    /// For chunks from Epic's CDN (about 1 MB, at most 8 MB). The 15 min total only stops a
    /// server that sends a byte now and then forever.
    pub fn for_chunks() -> UreqTransport {
        UreqTransport::new(Duration::from_secs(15 * 60))
    }

    /// For manifests from GitHub (up to ~35 MB).
    pub fn for_manifests() -> UreqTransport {
        UreqTransport::new(Duration::from_secs(30 * 60))
    }

    fn new(body_total: Duration) -> UreqTransport {
        let builder = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // never follow a redirect: only Epic's hosts and the two GitHub archives are contacted
            // (a 3xx comes back as a status and counts as a failed try)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            // idle timeout: restarts with every read from the connection
            .timeout_per_read(Some(IDLE_TIMEOUT))
            .timeout_recv_body(Some(body_total))
            // up to 32 requests at once to the same CDN host: keep their connections open
            .max_idle_connections(64)
            .max_idle_connections_per_host(32)
            .user_agent(format!("Rift/{}", env!("CARGO_PKG_VERSION")));
        #[cfg(windows)]
        let builder = {
            use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
            builder.tls_config(
                TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build(),
            )
        };
        UreqTransport { agent: builder.build().into() }
    }
}

fn net_error(e: ureq::Error) -> NetError {
    match e {
        ureq::Error::StatusCode(s) => NetError::Status(s),
        ureq::Error::Timeout(_) => NetError::Timeout,
        other => NetError::Other(other.to_string()),
    }
}

impl Transport for UreqTransport {
    fn head(&self, url: &str) -> Result<u16, NetError> {
        let resp = self.agent.head(url).call().map_err(net_error)?;
        Ok(resp.status().as_u16())
    }

    fn get(&self, url: &str, max_bytes: u64, stop: &AtomicBool) -> Result<Vec<u8>, NetError> {
        let mut resp = self.agent.get(url).call().map_err(net_error)?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(NetError::Status(status));
        }
        let expected = resp.body().content_length().unwrap_or(0).min(max_bytes).min(16 << 20);
        let mut reader = resp.body_mut().with_config().limit(max_bytes).reader();
        let mut out = Vec::with_capacity(expected as usize);
        let mut piece = vec![0u8; READ_PIECE];
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err(NetError::Stopped);
            }
            match reader.read(&mut piece) {
                Ok(0) => return Ok(out),
                Ok(n) => out.extend_from_slice(&piece[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(net_error(ureq::Error::from(e))),
            }
        }
    }
}
