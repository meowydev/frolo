import React, { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import useMediaQuery from "@mui/material/useMediaQuery";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { buildTheme, loadThemeMode, resolveMode, saveThemeMode, type ThemeMode } from "./theme.js";
import { SnackbarProvider } from "./ui/Snackbars.js";
import { api } from "./api.js";
import { Oobe } from "./oobe/Oobe.js";
import { Login } from "./screens/Login.js";
import { Shell } from "./shell/Shell.js";

export interface AppEnv {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
}
export const AppEnvContext = React.createContext<AppEnv>({ themeMode: "system", setThemeMode: () => {} });

export function App(): JSX.Element {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(loadThemeMode());
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => buildTheme(resolveMode(themeMode, prefersDark)), [themeMode, prefersDark]);

  const setThemeMode = (m: ThemeMode) => {
    saveThemeMode(m);
    setThemeModeState(m);
  };

  return (
    <AppEnvContext.Provider value={{ themeMode, setThemeMode }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <SnackbarProvider>
          <BrowserRouter>
            <Bootstrap />
          </BrowserRouter>
        </SnackbarProvider>
      </ThemeProvider>
    </AppEnvContext.Provider>
  );
}

// Decides where to send the user: OOBE (no setup), Login (setup done, no
// session), or the authenticated shell.
function Bootstrap(): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; setupComplete: boolean; authed: boolean }>({
    loading: true,
    setupComplete: false,
    authed: false,
  });

  const refresh = async () => {
    const [auth, me] = await Promise.all([api.authState().catch(() => ({ hasAccount: false, setupComplete: false })), api.me().catch(() => ({ account: null }))]);
    setState({ loading: false, setupComplete: auth.setupComplete, authed: Boolean(me.account) });
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (state.loading) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Routes>
      <Route path="/setup/*" element={<Oobe onDone={refresh} />} />
      <Route path="/login" element={<LoginGate authed={state.authed} onLoggedIn={refresh} />} />
      <Route
        path="/*"
        element={<Gate setupComplete={state.setupComplete} authed={state.authed} onChange={refresh} />}
      />
    </Routes>
  );
}

function LoginGate({ authed, onLoggedIn }: { authed: boolean; onLoggedIn: () => void }): JSX.Element {
  if (authed) return <Navigate to="/" replace />;
  return <Login onLoggedIn={onLoggedIn} />;
}

function Gate({
  setupComplete,
  authed,
  onChange,
}: {
  setupComplete: boolean;
  authed: boolean;
  onChange: () => void;
}): JSX.Element {
  const nav = useNavigate();
  useEffect(() => {
    if (!setupComplete) nav("/setup", { replace: true });
    else if (!authed) nav("/login", { replace: true });
  }, [setupComplete, authed, nav]);

  if (!setupComplete || !authed) return <Box sx={{ display: "grid", placeItems: "center", height: "100vh" }}><CircularProgress /></Box>;
  return <Shell onLogout={onChange} />;
}
