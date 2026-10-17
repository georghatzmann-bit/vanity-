; Phoenix – custom NSIS hooks (included via package.json build.nsis.include).
;
; Deliberately minimal: no registry writes, no marker files. Phoenix detects its first start
; itself (userData\installed-version, see src/main/ipc.js), and the installer starts the app
; non-elevated after the install (electron-builder oneClick + runAfterFinish -> StdUtils
; ExecShellAsUser in templates/nsis/common.nsh StartApp).
;
; Available hooks: customHeader, preInit, customInit, customInstall, customUnInstall,
; customCheckAppRunning (never override that one in a shipped build – it is the
; "Phoenix is still running" check), customUnInstallSection.

!macro customHeader
!macroend
