/**
 * Built-in voice registry — the Miro & Dii voices trained by TigreGóticoLda.
 *
 * Import from `phoonnx/voices`:
 * ```ts
 * import { voices, getVoice, getVoicesByLang } from "phoonnx/voices";
 * ```
 */
import type { VoiceEntry } from "./types.js";
import _voices from "./voices-data.json";

/** All registered phoonnx voices. */
export const voices: VoiceEntry[] = _voices as VoiceEntry[];

/** Look up a voice by its id string. Returns undefined if not found. */
export function getVoice(id: string): VoiceEntry | undefined {
  return voices.find((v) => v.id === id);
}

/** Get all voices for a given BCP-47 language code (exact match on `lang`). */
export function getVoicesByLang(lang: string): VoiceEntry[] {
  return voices.filter((v) => v.lang === lang);
}

/** Get all voices for a named speaker ("Miro" or "Dii"). */
export function getVoicesBySpeaker(speaker: string): VoiceEntry[] {
  return voices.filter((v) => v.voice === speaker);
}

/** Get all voices compatible with piper / Home Assistant. */
export function getHaCompatibleVoices(): VoiceEntry[] {
  return voices.filter((v) => v.haCompatible);
}
