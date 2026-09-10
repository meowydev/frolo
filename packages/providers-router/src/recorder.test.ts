import { describe, it, expect } from "vitest";
import { RecordingSession, buildLocators, looksGenerated, toRecordedStep } from "./recorder.js";

describe("recorder locator capture", () => {
  it("captures multiple strategies and never relies solely on generated ids", () => {
    const locs = buildLocators({
      kind: "fill",
      role: "textbox",
      accName: "External port",
      label: "External port",
      id: "z91k-ep",
      dataAttrs: { "data-testid": "ext-port" },
    });
    const kinds = locs.map((l) => l.by);
    expect(kinds).toContain("role");
    expect(kinds).toContain("label");
    expect(kinds).toContain("dataAttr");
    // the generated id is captured but flagged generated
    const idLoc = locs.find((l) => l.by === "id");
    expect(idLoc && idLoc.by === "id" && idLoc.generated).toBe(true);
    // there is at least one non-id, non-coordinate strategy
    expect(locs.some((l) => l.by !== "id" && l.by !== "coordinates")).toBe(true);
  });

  it("flags generated ids", () => {
    expect(looksGenerated("z91k-ep")).toBe(true);
    expect(looksGenerated("a1b2c3d4e5")).toBe(true);
    expect(looksGenerated("username")).toBe(false);
    expect(looksGenerated("ext-port")).toBe(false);
  });

  it("uses coordinates only as a last resort when nothing semantic exists", () => {
    const withSemantic = buildLocators({ kind: "click", role: "button", accName: "Save", coordinates: { x: 1, y: 2 } });
    expect(withSemantic.some((l) => l.by === "coordinates")).toBe(false);

    const onlyCoords = buildLocators({ kind: "click", coordinates: { x: 10, y: 20 } });
    expect(onlyCoords).toHaveLength(1);
    expect(onlyCoords[0]!.by).toBe("coordinates");
    if (onlyCoords[0]!.by === "coordinates") expect(onlyCoords[0]!.lastResort).toBe(true);
  });

  it("records password fields as fillSecret with a var binding and no value", () => {
    const step = toRecordedStep({ kind: "fill", label: "Password", isSecret: true });
    expect(step.kind).toBe("fillSecret");
    expect(step.binding).toEqual({ kind: "var", name: "router_password" });
    // No value field anywhere in the step
    expect(JSON.stringify(step)).not.toContain("value");
  });

  it("accumulates a recording", () => {
    const s = new RecordingSession();
    s.record({ kind: "navigate", url: "/portforward" });
    s.record({ kind: "fill", label: "Rule name" });
    s.record({ kind: "fill", label: "Password", isSecret: true });
    const steps = s.getSteps();
    expect(steps).toHaveLength(3);
    expect(steps[2]!.kind).toBe("fillSecret");
  });
});
