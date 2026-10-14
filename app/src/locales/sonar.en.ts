import type { Dict } from "./de";

/** English texts of the „sonar“ namespace (Hear your network) – plugged into `en.ts`. */
export const sonarEn: Dict["sonar"] = {
  title: "Hear your network",
  turnOn: "Hear your network: play the live ping as a Pulsar tone",
  turnOff: "Turn off Hear your network",
  playing: "Hear your network is playing",
  monitorOff: "Hear your network: resume the live monitor first",
  muted: "Pulsar sounds are off (Settings › Sound) – nothing to hear",
  blocked: "Sound is blocked right now (no audio device or paused by the system)",
  dropped: "Dropout (loss)",
  accent: "accented (spike)",
  legend: "Even = stable · stumbling = jitter · gaps = loss · accented = spike",
  settings: {
    desc: "Makes the live ping audible: one pulse per measurement. Turn it on in the cockpit (headphones button on the live ping card). The sound improves nothing – it only translates the measurement.",
    volume: "Volume",
    volumeDesc: "On top of the overall volume above.",
    pitch: "Pitch follows the ping",
    pitchDesc: "Brighter sound at low ping, darker at high ping (same steps as the ping grades). No melody – just a different resonance.",
    alertInGame: "Alert tone in game",
    alertInGameDesc: "A very quiet single tone when a spike is detected – only while a game is running, at most every 10 s. Reacts to Pulsar's measuring target, not the game's own connection. Works even when Hear your network is off.",
    alertVolume: "Alert tone volume",
    preview: "Preview",
    previewDesc: "4 seconds each with example values – not a real measurement.",
    previewStop: "Stop preview",
    previewNames: {
      stable: "Stable",
      unstable: "Jitter",
      loss: "Loss",
      alert: "Alert tone",
    },
    mutedHint: "Pulsar sounds are off – turn on “Sounds” above, otherwise everything stays silent.",
    honest: "The stumbling translates the measured jitter into sound; it is not the real timing of individual packets. When Pulsar is hidden in the tray, Hear your network stops; whether Windows still plays the alert tone then depends on WebView2.",
  },
};
