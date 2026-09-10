import React from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";

export function ModeStep({
  value,
  onChange,
}: {
  value: "mock" | "real";
  onChange: (m: "mock" | "real") => void;
}): JSX.Element {
  return (
    <Stack spacing={2}>
      <Typography variant="h6">How do you want to start?</Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <ModeCard
          selected={value === "mock"}
          onClick={() => onChange("mock")}
          title="Try Frolo safely"
          badge="recommended for the beta"
          body="Explore the whole Nginx deployment flow against a built-in simulation. No Proxmox connection needed, and nothing touches real infrastructure."
        />
        <ModeCard
          selected={value === "real"}
          onClick={() => onChange("real")}
          title="Connect my Proxmox"
          badge="real infrastructure"
          body="Connect to your Proxmox server with a restricted API token. Frolo validates the connection read-only during setup; deployments are always reviewed and confirmed."
        />
      </Stack>
    </Stack>
  );
}

function ModeCard(props: {
  selected: boolean;
  onClick: () => void;
  title: string;
  badge: string;
  body: string;
}): JSX.Element {
  return (
    <Card sx={{ flex: 1, borderColor: props.selected ? "primary.main" : undefined, borderWidth: props.selected ? 2 : 1 }}>
      <CardActionArea onClick={props.onClick} sx={{ height: "100%" }}>
        <CardContent>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>{props.title}</Typography>
            {props.selected && <Chip label="selected" size="small" color="primary" />}
          </Stack>
          <Chip label={props.badge} size="small" variant="outlined" sx={{ mb: 1 }} />
          <Typography variant="body2" color="text.secondary">{props.body}</Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
