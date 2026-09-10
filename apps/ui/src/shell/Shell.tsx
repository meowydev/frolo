// Authenticated app shell (req: app bar, nav drawer, responsive, theme toggle,
// beta label, account controls). Permanent drawer on desktop, temporary on
// mobile.

import React, { useContext, useState } from "react";
import { Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import DashboardIcon from "@mui/icons-material/Dashboard";
import DnsIcon from "@mui/icons-material/Dns";
import RouterIcon from "@mui/icons-material/Router";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import ShieldIcon from "@mui/icons-material/Shield";
import Brightness6Icon from "@mui/icons-material/Brightness6";
import AccountCircleIcon from "@mui/icons-material/AccountCircle";
import { AppEnvContext } from "../App.js";
import { api } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";
import { Dashboard } from "../screens/Dashboard.js";
import { NewDeployment } from "../screens/NewDeployment.js";
import { DeploymentDetails } from "../screens/DeploymentDetails.js";
import { Routers } from "../screens/Routers.js";
import { Recipes } from "../screens/Recipes.js";
import { VaultAudit } from "../screens/VaultAudit.js";

const DRAWER_WIDTH = 236;

const NAV = [
  { to: "/", label: "Dashboard", icon: <DashboardIcon /> },
  { to: "/routers", label: "Routers", icon: <RouterIcon /> },
  { to: "/recipes", label: "Recipes", icon: <MenuBookIcon /> },
  { to: "/vault", label: "Vault & audit", icon: <ShieldIcon /> },
];

export function Shell({ onLogout }: { onLogout: () => void }): JSX.Element {
  const theme = useTheme();
  const { notify } = useSnackbar();
  const { themeMode, setThemeMode } = useContext(AppEnvContext);
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<null | HTMLElement>(null);
  const nav = useNavigate();
  const loc = useLocation();

  async function doLogout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    onLogout();
    nav("/login", { replace: true });
  }

  const cycleTheme = () => {
    const order: Array<typeof themeMode> = ["light", "dark", "system"];
    const next = order[(order.indexOf(themeMode) + 1) % order.length]!;
    setThemeMode(next);
    notify(`Theme: ${next}`, "info");
  };

  const drawer = (
    <Box role="navigation">
      <Toolbar>
        <Typography variant="h6" fontWeight={800} color="primary">Frolo</Typography>
        <Chip label="beta" size="small" color="secondary" sx={{ ml: 1 }} />
      </Toolbar>
      <List>
        {NAV.map((item) => (
          <ListItemButton
            key={item.to}
            selected={loc.pathname === item.to}
            onClick={() => {
              nav(item.to);
              setMobileOpen(false);
            }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" color="default" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          {!isDesktop && (
            <IconButton edge="start" onClick={() => setMobileOpen((o) => !o)} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          <DnsIcon color="primary" sx={{ mr: 1 }} />
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Frolo panel</Typography>
          <Tooltip title="Cycle theme (light / dark / system)">
            <IconButton onClick={cycleTheme} aria-label="Toggle theme"><Brightness6Icon /></IconButton>
          </Tooltip>
          <IconButton onClick={(e) => setAccountAnchor(e.currentTarget)} aria-label="Account"><AccountCircleIcon /></IconButton>
          <Menu anchorEl={accountAnchor} open={Boolean(accountAnchor)} onClose={() => setAccountAnchor(null)}>
            <MenuItem disabled>Theme: {themeMode}</MenuItem>
            <MenuItem onClick={doLogout}>Sign out</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {isDesktop ? (
        <Drawer variant="permanent" sx={{ width: DRAWER_WIDTH, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" } }}>
          {drawer}
        </Drawer>
      ) : (
        <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ "& .MuiDrawer-paper": { width: DRAWER_WIDTH } }}>
          {drawer}
        </Drawer>
      )}

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, width: "100%" }}>
        <Toolbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<NewDeployment />} />
          <Route path="/deployments/:id" element={<DeploymentDetails />} />
          <Route path="/routers" element={<Routers />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/vault" element={<VaultAudit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Box>
    </Box>
  );
}
