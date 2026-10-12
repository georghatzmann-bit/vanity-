import { clsx, type ClassValue } from "clsx";

/** Klassen zusammenfügen (bedingte Tailwind-Klassen) */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
