import { describe, it, expect, vi } from "vitest";
import { createMedHubClient } from "./api";
import { createMisDelivery, prepareMisFields } from "./mis";
import { emptyTemplate, emptyVitals, FIELD_IDS } from "./visitTemplate";

const values = {
  ...emptyTemplate(),
  complaints: "Учебный приём",
  treatment: "Правка врача",
};
const vitals = { ...emptyVitals(), bp: "120/80" };
describe("final backend MIS workflow", () => {
  it("keeps all 13 sections and measurements in the export", () => {
    const result = prepareMisFields(values, vitals);
    expect(Object.keys(result.documentFields)).toEqual(FIELD_IDS);
    expect(result.documentFields.treatment).toBe("Правка врача");
    expect(result.documentFields.objective_status).toContain("120/80");
    expect(result.fields.prescriptions).toContain("Правка врача");
  });
  it("reuses the confirmed revision after a lost export response", async () => {
    let firstExport = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/mis-export")) {
        if (firstExport) {
          firstExport = false;
          throw new TypeError("Lost reply");
        }
        return Response.json({
          mode: "test_mis",
          document_id: "receipt",
          revision: 2,
          superseded: false,
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: "workspace",
        revision: path.endsWith("/workspaces") ? 1 : 2,
      });
    });
    const sender = createMisDelivery(createMedHubClient("/api", { fetcher }));
    await expect(sender.send(values, vitals, true)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect((await sender.send(values, vitals, true)).document_id).toBe(
      "receipt",
    );
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/workspaces")),
    ).toHaveLength(1);
    const exports = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/mis-export"),
    );
    expect(exports).toHaveLength(2);
    expect(exports[0][1]?.body).toBe(exports[1][1]?.body);
    expect(JSON.parse(exports[0][1]!.body as string)).toMatchObject({
      expected_revision: 2,
      patient_id: "demo-patient-001",
      synthetic_data_confirmed: true,
    });
  });
  it("requires explicit confirmation of synthetic data before any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sender = createMisDelivery(createMedHubClient("/api", { fetcher }));
    await expect(sender.send(values, vitals, false)).rejects.toMatchObject({
      code: "SYNTHETIC_ONLY",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not report a superseded form as delivered", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith("/mis-export")
          ? {
              mode: "test_mis",
              document_id: "receipt",
              revision: 2,
              superseded: true,
            }
          : { id: "workspace", revision: 2 },
      ),
    );
    const sender = createMisDelivery(createMedHubClient("/api", { fetcher }));
    await expect(sender.send(values, vitals, true)).rejects.toMatchObject({
      code: "MIS_UNCONFIRMED",
    });
  });
});
