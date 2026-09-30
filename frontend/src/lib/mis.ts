import {
  ApiError,
  type createMedHubClient,
  type Fields,
  type Workspace,
  type RequestOptions,
} from "./api";
import {
  VITAL_DEFINITIONS,
  type TemplateValues,
  type TemplateVitals,
} from "./visitTemplate";

export function prepareMisFields(
  values: TemplateValues,
  vitals: TemplateVitals,
) {
  const documentFields = { ...values };
  documentFields.objective_status = [
    VITAL_DEFINITIONS.filter((v) => vitals[v.id])
      .map((v) => `${v.label}: ${vitals[v.id]} ${v.unit}`)
      .join("; "),
    values.objective_status,
  ]
    .filter(Boolean)
    .join("\n");
  const fields: Fields = {
    complaints: values.complaints,
    allergies: values.allergies,
    diagnosis: values.diagnosis,
    anamnesis: [
      values.illness_history,
      values.life_history,
      values.gynecological_history,
      values.anemia_history,
      values.epidemiological_history,
      documentFields.objective_status,
      values.laboratory_results,
    ]
      .filter(Boolean)
      .join("\n"),
    prescriptions: [values.examination_plan, values.treatment]
      .filter(Boolean)
      .join("\n"),
    recommendations: values.recommendations,
  };
  return { fields, documentFields };
}

/** Isolate the checked form from live analysis. Keep its confirmed revision for safe retries. */
export function createMisDelivery(
  client: ReturnType<typeof createMedHubClient>,
) {
  let confirmed: { key: string; workspace: Workspace } | null = null;
  let busy = false;
  return {
    async send(
      values: TemplateValues,
      vitals: TemplateVitals,
      syntheticConfirmed: boolean,
      opts?: RequestOptions,
    ) {
      if (!syntheticConfirmed)
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "Подтвердите, что данные вымышленные.",
        );
      if (busy)
        throw new ApiError(
          409,
          "SEND_IN_PROGRESS",
          "Отправка уже выполняется.",
        );
      busy = true;
      try {
        const prepared = prepareMisFields(values, vitals);
        const key = JSON.stringify(prepared);
        if (confirmed?.key !== key) {
          const old = confirmed;
          confirmed = null;
          if (old) void client.remove(old.workspace.id).catch(() => {});
          let workspace = await client.create(opts);
          try {
            workspace = await client.saveDocument(
              workspace,
              prepared.fields,
              prepared.documentFields,
              opts,
            );
            workspace = await client.confirm(workspace, opts);
            confirmed = { key, workspace };
          } catch (reason) {
            void client.remove(workspace.id).catch(() => {});
            throw reason;
          }
        }
        const receipt = await client.sendMis(confirmed.workspace, opts);
        if (
          receipt.mode !== "test_mis" ||
          !receipt.document_id ||
          receipt.superseded ||
          receipt.revision !== confirmed.workspace.revision
        )
          throw new ApiError(
            502,
            "MIS_UNCONFIRMED",
            "Получение текущей версии бланка не подтверждено.",
          );
        return receipt;
      } finally {
        busy = false;
      }
    },
    dispose() {
      if (confirmed) void client.remove(confirmed.workspace.id).catch(() => {});
      confirmed = null;
    },
  };
}
