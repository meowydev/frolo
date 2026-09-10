import React from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";

export function OptionalStep({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{title}</Typography>
      <Typography variant="body2" color="text.secondary">{description}</Typography>
      <Alert severity="info">This step is optional. Use Skip to continue, or set it up later from the dashboard.</Alert>
    </Stack>
  );
}
