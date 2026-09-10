// Material Design 2 theme (req: MUI, purple primary + playful accents, light/dark
// + system sync, rounded shapes). Theme preference is persisted per browser.

import { createTheme, type Theme } from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "system";

const shared = {
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    button: { textTransform: "none" as const, fontWeight: 600 },
  },
} as const;

export function buildTheme(effective: "light" | "dark"): Theme {
  return createTheme({
    ...shared,
    palette: {
      mode: effective,
      primary: { main: "#7c4dff" }, // playful Frolo purple
      secondary: { main: "#26c6da" }, // teal accent
      success: { main: "#43a047" },
      warning: { main: "#f9a825" },
      error: { main: "#e53935" },
      ...(effective === "dark"
        ? { background: { default: "#0f1420", paper: "#171d2b" } }
        : { background: { default: "#f5f6fa", paper: "#ffffff" } }),
    },
    components: {
      MuiCard: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: "1px solid", borderColor: "rgba(128,128,128,.2)" } } },
      MuiButton: { defaultProps: { disableElevation: true } },
    },
  });
}

const STORAGE_KEY = "frolo.themeMode";

export function loadThemeMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}
export function saveThemeMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

// Resolve a mode (respecting system preference) to an effective palette.
export function resolveMode(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
