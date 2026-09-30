; Jarvis - Windows-Installer (Inno Setup 6). Ergebnis: Output\JarvisSetup.exe
; Gebaut wird er auf GitHub (Windows): .github/workflows/setup-exe.yml
; Installiert ohne Admin-Rechte nach %LOCALAPPDATA%\Programs\Jarvis. Python und alle
; Pakete holt werkzeuge\installieren.ps1 im Automatik-Modus (-Auto).

#define AppVersion GetEnv("JARVIS_VERSION")
#if AppVersion == ""
  #define AppVersion "1.2.0"
#endif

[Setup]
AppId={{6F2C3E1A-7B4D-4E8A-9C1F-4A5B6C7D8E9F}
AppName=Jarvis
AppVersion={#AppVersion}
AppVerName=Jarvis {#AppVersion}
AppPublisher=Jarvis
DefaultDirName={localappdata}\Programs\Jarvis
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=JarvisSetup
SetupIconFile=jarvis.ico
UninstallDisplayIcon={app}\jarvis.ico
UninstallDisplayName=Jarvis
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Messages]
de.WelcomeLabel2=Jarvis wird jetzt auf deinem PC eingerichtet.%n%nDer Installer lädt dabei alles Nötige kostenlos herunter (Python, Spracherkennung, Stimmen). Das dauert beim ersten Mal ein paar Minuten.%n%nFür das Gehirn brauchst du Claude Code mit deinem Claude-Pro-Abo. Das richtet die Einrichtung danach mit dir ein.

[Tasks]
Name: "autostart"; Description: "Jarvis mit Windows starten (immer erreichbar)"

[Files]
Source: "..\jarvis\*"; DestDir: "{app}\jarvis"; Excludes: "__pycache__,*.pyc"; Flags: recursesubdirs ignoreversion
Source: "..\jarvis_home\*"; DestDir: "{app}\jarvis_home"; Flags: recursesubdirs ignoreversion
Source: "..\werkzeuge\*"; DestDir: "{app}\werkzeuge"; Flags: recursesubdirs ignoreversion
Source: "..\Jarvis.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements-extras.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.example.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ANLEITUNG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "jarvis.ico"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{localappdata}\Jarvis\venv\Scripts\pythonw.exe"; Parameters: "-m jarvis"; WorkingDir: "{app}"; Description: "Jarvis jetzt starten"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /F /FI ""WINDOWTITLE eq Jarvis*"""; Flags: runhidden; RunOnceId: "JarvisBeenden"

[UninstallDelete]
Type: files; Name: "{userstartup}\Jarvis.cmd"
Type: files; Name: "{userdesktop}\Jarvis.lnk"
Type: files; Name: "{userprograms}\Jarvis.lnk"
Type: filesandordirs; Name: "{localappdata}\Jarvis"
Type: filesandordirs; Name: "{app}"

[Code]
function RunInstaller(): Integer;
var
  Code: Integer;
  Show: Integer;
begin
  if WizardSilent() then Show := SW_HIDE else Show := SW_SHOWNORMAL;
  if not Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\werkzeuge\installieren.ps1') + '" -Auto',
      ExpandConstant('{app}'), Show, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Dummy: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Jarvis lädt alles Nötige herunter. Das dauert beim ersten Mal ein paar Minuten ...';
    Code := RunInstaller();
    if Code <> 0 then
    begin
      SuppressibleMsgBox('Beim Herunterladen der Bestandteile ist etwas schiefgegangen (Code ' + IntToStr(Code) + ').' + #13#10 + #13#10 +
        'Details stehen in ' + ExpandConstant('{localappdata}\Jarvis\installation.log') + '.' + #13#10 +
        'Meist hilft es, JarvisSetup.exe mit Internet einfach noch einmal zu starten.', mbError, MB_OK, IDOK);
    end
    else if WizardIsTaskSelected('autostart') then
      Exec(ExpandConstant('{localappdata}\Jarvis\venv\Scripts\python.exe'), '-m jarvis --autostart an',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Dummy);
  end;
end;
