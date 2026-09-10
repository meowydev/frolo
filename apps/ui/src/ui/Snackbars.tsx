// Snackbar provider (req: snackbars instead of browser alerts). Exposes a
// notify() function via context; components call it for transient feedback.

import React, { createContext, useCallback, useContext, useState } from "react";
import Snackbar from "@mui/material/Snackbar";
import Alert, { type AlertColor } from "@mui/material/Alert";

interface SnackMessage {
  key: number;
  text: string;
  severity: AlertColor;
}

interface SnackContextValue {
  notify: (text: string, severity?: AlertColor) => void;
}

const SnackContext = createContext<SnackContextValue>({ notify: () => {} });

export function useSnackbar(): SnackContextValue {
  return useContext(SnackContext);
}

export function SnackbarProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [current, setCurrent] = useState<SnackMessage | null>(null);

  const notify = useCallback((text: string, severity: AlertColor = "info") => {
    setCurrent({ key: Date.now(), text, severity });
  }, []);

  return (
    <SnackContext.Provider value={{ notify }}>
      {children}
      <Snackbar
        key={current?.key}
        open={Boolean(current)}
        autoHideDuration={5000}
        onClose={() => setCurrent(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {current ? (
          <Alert severity={current.severity} variant="filled" onClose={() => setCurrent(null)}>
            {current.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </SnackContext.Provider>
  );
}
