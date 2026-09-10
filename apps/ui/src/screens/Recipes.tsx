import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import { api } from "../api.js";
import type { Recipe } from "@frolo/contracts";

export function Recipes(): JSX.Element {
  const [recipes, setRecipes] = useState<{ recipe: Recipe; checksum: string }[]>([]);
  useEffect(() => {
    api.listRecipes().then(setRecipes).catch(() => {});
  }, []);

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>Recipes</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Recipes are declarative, versioned, and checksum-verified. Frolo runs only known, typed
        operations — never arbitrary scripts.
      </Typography>
      <Stack spacing={2}>
        {recipes.map(({ recipe, checksum }) => (
          <Card key={recipe.id}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={700}>{recipe.name} v{recipe.version}</Typography>
                <Chip label="checksum verified" color="success" size="small" />
              </Stack>
              <Box component="ol" sx={{ pl: 3, m: 0, fontFamily: "monospace", fontSize: 13 }}>
                {recipe.operations.map((op, i) => (
                  <li key={i}>{describeOp(op)}</li>
                ))}
              </Box>
              <Typography variant="caption" color="text.secondary">sha256: {checksum.slice(0, 16)}…</Typography>
            </CardContent>
          </Card>
        ))}
        {recipes.length === 0 && <Typography color="text.secondary">No recipes registered.</Typography>}
      </Stack>
    </Box>
  );
}

function describeOp(op: Recipe["operations"][number]): string {
  switch (op.type) {
    case "pkg.install": return `pkg.install ${op.packages.join(", ")}`;
    case "file.write": return `file.write ${op.path}`;
    case "service.enable": return `service.enable ${op.name}`;
    case "service.start": return `service.start ${op.name}`;
    case "http.check": return `http.check ${op.path} expect ${op.expectStatus}`;
  }
}
