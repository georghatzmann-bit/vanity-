//! Land einer IP-Adresse aus der gebündelten Tabelle `rules/geo/ip-country.bin` (iptoasn.com,
//! Public Domain). Ohne Netz, ohne Dienstleister. IPv6 wird über die oberen 64 Bit zugeordnet.

use std::net::IpAddr;
use std::sync::LazyLock;

const TABLE: &[u8] = include_bytes!("../../../rules/geo/ip-country.bin");

/// Gelesene Tabelle.
#[derive(Debug, Default)]
pub struct GeoDb {
    codes: Vec<[u8; 2]>,
    v4: Vec<(u32, u32, u8)>,
    v6: Vec<(u64, u64, u8)>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(b)
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from(self.u8()?) | (u16::from(self.u8()?) << 8))
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from(self.u16()?) | (u32::from(self.u16()?) << 16))
    }

    fn varint(&mut self) -> Option<u128> {
        let mut value: u128 = 0;
        for shift in (0..).step_by(7).take(19) {
            let b = self.u8()?;
            value |= u128::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    /// Bereiche einer Familie (Ende als `u128`, wird vom Aufrufer begrenzt).
    fn ranges(&mut self, codes: usize, max: u128) -> Option<Vec<(u128, u128, u8)>> {
        let count = usize::try_from(self.u32()?).ok()?;
        let mut out = Vec::with_capacity(count.min(1_000_000));
        let mut next: u128 = 0;
        for _ in 0..count {
            let start = next.checked_add(self.varint()?)?;
            let end = start.checked_add(self.varint()?)?;
            let code = self.u8()?;
            if end > max || usize::from(code) >= codes {
                return None;
            }
            out.push((start, end, code));
            next = end.checked_add(1)?;
        }
        Some(out)
    }
}

impl GeoDb {
    /// Liest eine Tabelle; `None` bei falschem Format.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut r = Reader { bytes, at: 0 };
        for expected in b"AEGEO1\n" {
            if r.u8()? != *expected {
                return None;
            }
        }
        let count = usize::from(r.u16()?);
        let mut codes = Vec::with_capacity(count);
        for _ in 0..count {
            codes.push([r.u8()?, r.u8()?]);
        }
        let v4 = r
            .ranges(count, u128::from(u32::MAX))?
            .into_iter()
            .map(|(s, e, c)| Some((u32::try_from(s).ok()?, u32::try_from(e).ok()?, c)))
            .collect::<Option<Vec<_>>>()?;
        let v6 = r
            .ranges(count, u128::from(u64::MAX))?
            .into_iter()
            .map(|(s, e, c)| Some((u64::try_from(s).ok()?, u64::try_from(e).ok()?, c)))
            .collect::<Option<Vec<_>>>()?;
        Some(Self { codes, v4, v6 })
    }

    fn find<T: Ord + Copy>(ranges: &[(T, T, u8)], key: T) -> Option<u8> {
        let i = ranges.partition_point(|(start, _, _)| *start <= key);
        let (start, end, code) = *ranges.get(i.checked_sub(1)?)?;
        (start <= key && key <= end).then_some(code)
    }

    /// Ländercode (ISO 3166, z. B. `DE`) oder `None` (privat, unbekannt).
    #[must_use]
    pub fn country(&self, ip: IpAddr) -> Option<String> {
        let code = match ip {
            IpAddr::V4(v4) => Self::find(&self.v4, u32::from(v4))?,
            IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return self.country(IpAddr::V4(v4));
                }
                let top = u64::try_from(u128::from(v6) >> 64).ok()?;
                Self::find(&self.v6, top)?
            }
        };
        let [a, b] = *self.codes.get(usize::from(code))?;
        Some(String::from_utf8_lossy(&[a, b]).into_owned())
    }

    /// Anzahl Bereiche (IPv4, IPv6).
    #[must_use]
    pub fn len(&self) -> (usize, usize) {
        (self.v4.len(), self.v6.len())
    }

    /// Leer?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.v4.is_empty() && self.v6.is_empty()
    }
}

/// Die gebündelte Tabelle (einmal gelesen; bei Fehlern leer – dann ohne Länder).
#[must_use]
pub fn geo() -> &'static GeoDb {
    static DB: LazyLock<GeoDb> = LazyLock::new(|| GeoDb::parse(TABLE).unwrap_or_default());
    &DB
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gebuendelte_tabelle() {
        let db = geo();
        let (v4, v6) = db.len();
        assert!(v4 > 100_000 && v6 > 10_000, "{v4} {v6}");
        // 1.1.1.1 liegt in einem Bereich von APNIC/Cloudflare (AU), 8.8.8.8 bei Google (US).
        assert_eq!(
            db.country("8.8.8.8".parse().unwrap()).as_deref(),
            Some("US")
        );
        assert!(db.country("1.1.1.1".parse().unwrap()).is_some());
        assert_eq!(db.country("192.168.1.10".parse().unwrap()), None);
        assert_eq!(db.country("127.0.0.1".parse().unwrap()), None);
        assert_eq!(
            db.country("2001:4860:4860::8888".parse().unwrap())
                .as_deref(),
            Some("US")
        );
        assert_eq!(
            db.country("::ffff:8.8.8.8".parse().unwrap()).as_deref(),
            Some("US")
        );
    }

    #[test]
    fn kaputte_tabellen_werden_abgelehnt() {
        assert!(GeoDb::parse(b"").is_none());
        assert!(GeoDb::parse(b"AEGEO1\n").is_none());
        assert!(GeoDb::parse(&TABLE[..TABLE.len() / 2]).is_none());
        let mut bad = TABLE.to_vec();
        bad[0] = b'X';
        assert!(GeoDb::parse(&bad).is_none());
    }
}
