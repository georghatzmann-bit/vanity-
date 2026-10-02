; Jarvis - der Installations-Kern (Inno Setup 6). Ergebnis: Output\JarvisKern.exe
; JarvisSetup.exe (installer\setup, die Oberfläche) bettet ihn ein und startet ihn unsichtbar.
; Gebaut wird beides auf GitHub (Windows): .github/workflows/setup-exe.yml
; Installiert ohne Admin-Rechte nach %LOCALAPPDATA%\Programs\Jarvis. Python und alle
; Pakete holt werkzeuge\installieren.ps1 im Automatik-Modus (-Auto).
; Der Kern bleibt für Deinstallation und "Apps & Features" zuständig.
;
; Fortschritt: Ist JARVIS_FORTSCHRITT gesetzt, schreibt der Kern Zeilen wie
; "JARVIS-SCHRITT 1/6 Vorbereiten" in diese Datei, installieren.ps1 macht dort weiter.
; Scheitert installieren.ps1, endet der Kern mit 100 + dessen Code (z. B. 110: kein Internet).

#define AppVersion GetEnv("JARVIS_VERSION")
#if AppVersion == ""
  #define AppVersion "2.0.0"
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
OutputBaseFilename=JarvisKern
SetupIconFile=jarvis.ico
UninstallDisplayIcon={app}\jarvis.ico
UninstallDisplayName=Jarvis
Compression=lzma2
SolidCompression=yes
; Dunkel und blau wie Jarvis (ab Inno Setup 6.6), sonst das helle Standard-Aussehen.
; Sichtbar nur, wenn jemand JarvisKern.exe direkt startet, und beim Deinstallieren.
#if Ver >= EncodeVer(6, 6, 0)
WizardStyle=modern dark polar includetitlebar hidebevels
#else
WizardStyle=modern
#endif
WizardImageFile=wizard-100.bmp,wizard-200.bmp
WizardSmallImageFile=wizard-klein-100.bmp,wizard-klein-200.bmp
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Messages]
de.WelcomeLabel1=Willkommen bei Jarvis
de.WelcomeLabel2=Jarvis wird jetzt auf deinem PC eingerichtet.%n%nDer Installer holt alles Nötige selbst: Python, Spracherkennung, Stimmen und Jarvis' Gehirn (Claude Code). Das dauert beim ersten Mal ein paar Minuten.%n%nDanach läuft Jarvis im Hintergrund. Sag einfach „Hey Jarvis“. Handy, Alexa und Discord verbindest du später im Jarvis-Fenster unter „Verbinden“.
de.FinishedHeadingLabel=Jarvis ist bereit
de.FinishedLabel=Gleich öffnet sich die Einrichtung: Mikrofon, Stimme und die Anmeldung für das Gehirn. Danach sag einfach „Hey Jarvis“.
de.WinVersionTooLowError=Jarvis braucht Windows 10 ab Version 1809 oder Windows 11.

[Tasks]
Name: "autostart"; Description: "Jarvis mit Windows starten (läuft unsichtbar im Hintergrund, immer erreichbar)"
Name: "desktopicon"; Description: "Symbol auf dem Desktop"; Flags: unchecked

[Files]
Source: "..\jarvis\*"; DestDir: "{app}\jarvis"; Excludes: "__pycache__,*.pyc"; Flags: recursesubdirs ignoreversion
Source: "..\jarvis_home\*"; DestDir: "{app}\jarvis_home"; Flags: recursesubdirs ignoreversion
Source: "..\werkzeuge\*"; DestDir: "{app}\werkzeuge"; Flags: recursesubdirs ignoreversion
Source: "..\Jarvis.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Jarvis.pyw"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements-extras.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.example.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ANLEITUNG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "jarvis.ico"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; Schalter "Symbol auf dem Desktop" aus: ein altes Symbol verschwindet auch.
Type: files; Name: "{userdesktop}\Jarvis.lnk"; Tasks: not desktopicon

[Icons]
; Direkt pythonw + Jarvis.pyw: kein Konsolenfenster, eigenes Symbol, eigener Taskleisten-Eintrag
Name: "{userprograms}\Jarvis"; Filename: "{localappdata}\Jarvis\venv\Scripts\pythonw.exe"; Parameters: """{app}\Jarvis.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\jarvis.ico"; Comment: "Jarvis zeigen"; AppUserModelID: "Jarvis.Assistent"
Name: "{userdesktop}\Jarvis"; Filename: "{localappdata}\Jarvis\venv\Scripts\pythonw.exe"; Parameters: """{app}\Jarvis.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\jarvis.ico"; Comment: "Jarvis zeigen"; AppUserModelID: "Jarvis.Assistent"; Tasks: desktopicon

[Registry]
; Autostart: unsichtbar im Hintergrund, nur das Symbol neben der Uhr
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Jarvis"; ValueData: """{localappdata}\Jarvis\venv\Scripts\pythonw.exe"" ""{app}\Jarvis.pyw"" --hintergrund"; Flags: uninsdeletevalue; Tasks: autostart
; Schalter "Mit Windows starten" aus: einen alten Eintrag entfernen
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Jarvis"; Flags: deletevalue; Tasks: not autostart

[Run]
Filename: "{localappdata}\Jarvis\venv\Scripts\pythonw.exe"; Parameters: """{app}\Jarvis.pyw"""; WorkingDir: "{app}"; Description: "Jarvis jetzt starten"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-CimInstance Win32_Process -Filter \""Name='pythonw.exe' or Name='python.exe'\"" | Where-Object {{ $_.CommandLine -like '*Jarvis*' } | Invoke-CimMethod -MethodName Terminate"""; Flags: runhidden; RunOnceId: "JarvisBeenden"

[UninstallDelete]
Type: files; Name: "{userstartup}\Jarvis.cmd"
Type: filesandordirs; Name: "{localappdata}\Jarvis"
Type: filesandordirs; Name: "{app}"

[Code]
var
  FortschrittDatei: String;
  LetzterAnteil: Integer;
  KomponentenCode: Integer;

function InitializeSetup(): Boolean;
begin
  FortschrittDatei := GetEnv('JARVIS_FORTSCHRITT');
  LetzterAnteil := -1;
  KomponentenCode := 0;
  Result := True;
end;

{ Eine Zeile für die Oberfläche (JarvisSetup.exe). Nur ASCII, die Oberfläche kennt die Texte.
  Liest die Oberfläche gerade mit, ist die Datei kurz gesperrt: dann nochmal. }
procedure Melde(const Zeile: String);
var
  Versuch: Integer;
begin
  Log(Zeile);
  if FortschrittDatei = '' then
    Exit;
  for Versuch := 1 to 20 do
  begin
    if SaveStringToFile(FortschrittDatei, Zeile + #13#10, True) then
      Exit;
    Sleep(25);
  end;
end;

{ Dateien kopieren ist der Teil 10 bis 60 % von Schritt 1, den Rest prüft installieren.ps1. }
procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  Anteil: Integer;
begin
  if MaxProgress <= 0 then
    Exit;
  Anteil := 10 + Integer((Int64(CurProgress) * 50) div MaxProgress);
  if Anteil >= LetzterAnteil + 5 then
  begin
    LetzterAnteil := Anteil;
    Melde('JARVIS-ANTEIL ' + IntToStr(Anteil));
  end;
end;

function RunInstaller(): Integer;
var
  Code: Integer;
  Show: Integer;
begin
  if WizardSilent() then Show := SW_HIDE else Show := SW_SHOWNORMAL;
  if not Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\werkzeuge\installieren.ps1') + '" -Auto -OhneVerknuepfung',
      ExpandConstant('{app}'), Show, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

procedure StopJarvis();
var
  Code: Integer;
begin
  // Ein laufendes (altes) Jarvis beenden: Sonst sperrt es Dateien in seiner Python-Umgebung,
  // und das Aktualisieren der Pakete schlägt fehl. Danach startet der Installer es neu.
  Exec('powershell.exe',
    '-NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''pythonw.exe'' or Name=''python.exe''\" | ' +
    'Where-Object { $_.CommandLine -like ''*Jarvis*'' } | Invoke-CimMethod -MethodName Terminate | Out-Null; Start-Sleep -Milliseconds 800"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssInstall then
  begin
    Melde('JARVIS-SCHRITT 1/6 Vorbereiten');
    StopJarvis();
    Melde('JARVIS-ANTEIL 10');
    Melde('JARVIS-DETAIL Dateien werden kopiert');
  end;
  if CurStep = ssPostInstall then
  begin
    Melde('JARVIS-ANTEIL 60');
    WizardForm.StatusLabel.Caption := 'Jarvis lädt alles Nötige herunter. Das dauert beim ersten Mal ein paar Minuten ...';
    Code := RunInstaller();
    Log('installieren.ps1 beendet mit ' + IntToStr(Code));
    if Code <> 0 then
    begin
      KomponentenCode := Code;
      if Code < 0 then
        Melde('JARVIS-FEHLER 1 99 Windows PowerShell startet nicht.');
      SuppressibleMsgBox('Beim Herunterladen der Bestandteile ist etwas schiefgegangen (Code ' + IntToStr(Code) + ').' + #13#10 + #13#10 +
        'Details stehen in ' + ExpandConstant('{localappdata}\Jarvis\installation.log') + '.' + #13#10 +
        'Meist hilft es, JarvisSetup.exe mit Internet einfach noch einmal zu starten.', mbError, MB_OK, IDOK);
    end;
  end;
end;

{ Ging bei installieren.ps1 etwas schief, soll das auch der Rückgabewert sagen (für
  JarvisSetup.exe und die Proben im Build): 100 + Code, 199 wenn PowerShell nicht startet. }
function GetCustomSetupExitCode(): Integer;
begin
  Result := 0;
  if KomponentenCode <> 0 then
  begin
    if (KomponentenCode > 0) and (KomponentenCode < 99) then
      Result := 100 + KomponentenCode
    else
      Result := 199;
  end;
end;
