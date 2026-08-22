import { cadenceEpoch, type InvestmentCadence } from "../domain/epoch.js";

export function sessionEpochId(cadence: InvestmentCadence, date = new Date()) {
  return cadenceEpoch(cadence, date);
}
