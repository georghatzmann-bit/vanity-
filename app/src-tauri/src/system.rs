//! Systemwerte für das Dashboard: CPU, RAM, Laufzeit und (unter Windows) GPU-Auslastung.

use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::State;

use crate::error::{blocking, CmdResult, LockExt};
use crate::models::SystemStats;
use crate::state::Shared;

/// Hält `sysinfo` und die GPU-Abfrage zwischen den Aufrufen offen
/// (CPU-/GPU-Auslastung braucht zwei Messpunkte).
pub struct SystemMonitor {
    sys: System,
    cpu_name: Option<String>,
    #[cfg(windows)]
    gpu: Option<gpu::GpuMonitor>,
    #[cfg(windows)]
    gpu_tried: bool,
    gpu_name: Option<Option<String>>,
}

impl SystemMonitor {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        sys.refresh_cpu_usage();
        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            sys,
            cpu_name,
            #[cfg(windows)]
            gpu: None,
            #[cfg(windows)]
            gpu_tried: false,
            gpu_name: None,
        }
    }

    pub fn stats(&mut self) -> SystemStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let cpu = self.sys.global_cpu_usage();
        let cpu = if cpu.is_finite() { cpu.clamp(0.0, 100.0) } else { 0.0 };

        if self.gpu_name.is_none() {
            self.gpu_name = Some(gpu_name());
        }

        SystemStats {
            cpu,
            ram_used: self.sys.used_memory(),
            ram_total: self.sys.total_memory(),
            gpu: self.gpu_usage(),
            cpu_name: self.cpu_name.clone(),
            gpu_name: self.gpu_name.clone().flatten(),
            uptime_seconds: Some(System::uptime()),
        }
    }

    #[cfg(windows)]
    fn gpu_usage(&mut self) -> Option<f32> {
        if self.gpu.is_none() && !self.gpu_tried {
            self.gpu_tried = true;
            self.gpu = gpu::GpuMonitor::new();
        }
        self.gpu.as_mut().and_then(|g| g.sample())
    }

    #[cfg(not(windows))]
    fn gpu_usage(&mut self) -> Option<f32> {
        None
    }
}

impl Default for SystemMonitor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
fn gpu_name() -> Option<String> {
    gpu::adapter_name()
}

#[cfg(not(windows))]
fn gpu_name() -> Option<String> {
    None
}

#[cfg(windows)]
mod gpu {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
        PDH_MORE_DATA,
    };

    /// Offene PDH-Abfrage auf `\GPU Engine(*engtype_3D)\Utilization Percentage`.
    pub struct GpuMonitor {
        query: PDH_HQUERY,
        counter: PDH_HCOUNTER,
    }

    // Die PDH-Handles sind nicht an einen Thread gebunden.
    unsafe impl Send for GpuMonitor {}

    impl GpuMonitor {
        pub fn new() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut counter = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(
                    query,
                    w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"),
                    0,
                    &mut counter,
                ) != 0
                {
                    PdhCloseQuery(query);
                    return None;
                }
                // Erster Messpunkt
                PdhCollectQueryData(query);
                Some(Self { query, counter })
            }
        }

        /// Summe aller 3D-Engines (0..100).
        pub fn sample(&mut self) -> Option<f32> {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let mut size: u32 = 0;
                let mut count: u32 = 0;
                let status = PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut size,
                    &mut count,
                    None,
                );
                if status != PDH_MORE_DATA {
                    // Keine Instanzen (z. B. gerade keine 3D-Last) → 0 %
                    return if status == 0 { Some(0.0) } else { None };
                }
                if size == 0 {
                    return Some(0.0);
                }
                let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
                let len = (size as usize).div_ceil(item_size) + 1;
                let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = vec![std::mem::zeroed(); len];
                let mut size2 = (len * item_size) as u32;
                let status = PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut size2,
                    &mut count,
                    Some(buf.as_mut_ptr()),
                );
                if status != 0 {
                    return None;
                }
                let mut total = 0.0f64;
                for item in buf.iter().take(count as usize) {
                    // CStatus 0 = gültiger Wert
                    if item.FmtValue.CStatus == 0 {
                        let v = item.FmtValue.Anonymous.doubleValue;
                        if v.is_finite() && v > 0.0 {
                            total += v;
                        }
                    }
                }
                Some(total.clamp(0.0, 100.0) as f32)
            }
        }
    }

    impl Drop for GpuMonitor {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    /// Name der stärksten Grafikkarte (meistem eigenen Grafikspeicher), ohne Software-Renderer.
    pub fn adapter_name() -> Option<String> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut best: Option<(usize, String)> = None;
            let mut i = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(i) {
                i += 1;
                let Ok(desc) = adapter.GetDesc1() else { continue };
                if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                    continue;
                }
                let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..end]).trim().to_string();
                if name.is_empty() || name.contains("Microsoft Basic Render Driver") {
                    continue;
                }
                let mem = desc.DedicatedVideoMemory;
                if best.as_ref().map(|(m, _)| mem > *m).unwrap_or(true) {
                    best = Some((mem, name));
                }
            }
            best.map(|(_, n)| n)
        }
    }
}

#[tauri::command]
pub async fn system_stats(state: State<'_, Shared>) -> CmdResult<SystemStats> {
    let core = state.inner().clone();
    blocking(move || Ok(core.sys.lock_safe().stats())).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn stats_are_sane() {
        let mut m = super::SystemMonitor::new();
        let s = m.stats();
        assert!(s.ram_total > 0);
        assert!(s.ram_used <= s.ram_total);
        assert!((0.0..=100.0).contains(&s.cpu));
    }
}
