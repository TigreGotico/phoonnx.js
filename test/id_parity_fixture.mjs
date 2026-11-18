// The token-id fixture that phoonnx and phoonnx.js share.
//
// Python phoonnx owns the fixture: tests/fixtures/id_parity.json in
// TigreGotico/phoonnx lists voices (with their config files) and rows of
// (voice id, text, ids per sentence). The tests read it at the commit named
// below. PHOONNX_ID_FIXTURE names a local copy to read instead, for a run
// with no network or a fixture that is not published yet.
import { readFile } from "node:fs/promises";

export const PHOONNX_COMMIT = "738a795970787d9a2981c0e618e1667bc149d5e3";
const URL_OF_FIXTURE =
  `https://raw.githubusercontent.com/TigreGotico/phoonnx/${PHOONNX_COMMIT}/tests/fixtures/id_parity.json`;

export async function loadIdParityFixture() {
  const local = process.env.PHOONNX_ID_FIXTURE;
  if (local) return JSON.parse(await readFile(local, "utf8"));
  const response = await fetch(URL_OF_FIXTURE);
  if (!response.ok) throw new Error(`${URL_OF_FIXTURE}: HTTP ${response.status}`);
  return response.json();
}
