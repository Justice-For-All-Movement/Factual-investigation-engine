import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const r = read("registry/prs.json"),
  p = read("docs/approved-design/development_backlog.json"),
  catalog = read("docs/approved-design/engine_catalog.json");
// The repository moved organizations; the registry record keeps its original name. Either owner is accepted, the name is not.
assert.match(r.repository, /^(neophilism|Justice-For-All-Movement)\/factual-investigation-engine$/i);
const pinned = (name, repo, sha) => {
  const value = read("package.json").dependencies[name];
  assert.equal(value, "git+https://github.com/Justice-For-All-Movement/" + repo + ".git#" + sha, name + " must stay pinned to the accepted commit");
};
assert(r.planVerified);
assert.equal(p.tasks.length, 122);
assert.equal(catalog.engines.length, 15);
const tasks = p.tasks.filter((t) => t.engines.includes("E08"));
assert.deepEqual(r.units.map((u) => u.legacyWorkUnitId), tasks.map((t) => t.id));
assert.equal(r.plannedPrCount, tasks.length);

const canonical = (id) => id.replaceAll(".", "-");
const indexedIds = new Set(tasks.map((task) => task.id));
for (const task of tasks) {
  const unit = r.units.find((u) => u.legacyWorkUnitId === task.id);
  assert(unit, "Missing original source task " + task.id);
  assert.equal(unit.id, canonical(task.id), "Canonical ID mapping differs from source");
  assert.deepEqual(
    unit.dependsOn,
    task.dependencies.filter((id) => indexedIds.has(id)).map(canonical),
    "Original same-repository dependencies changed"
  );
  const expectedUnresolved = task.dependencies.filter((id) => !indexedIds.has(id))
    .map((id) => "Required original cross-project milestone " + id +
      " is not yet mapped to a verified upstream repo/unit; block this unit until source evidence is linked");
  for (const prerequisite of expectedUnresolved) {
    assert(unit.externalPrerequisites.includes(prerequisite),
      "Missing original cross-project dependency hold for " + task.id);
  }
  assert.deepEqual(unit.externalDependencies, [],
    "External dependency must not claim a verified upstream mapping until evidence exists");
  assert.deepEqual(unit.prs, [], "Do not fabricate completed PR evidence");
}
pinned("@accountability/knowledge-verification", "Knowledge-and-verification-engine", "cb69243a48578feb07e85704185cced98964b1e4");
console.log(
  "Valid E08 registry:15 engines/122 tasks; original IDs/dependencies and Knowledge pin retained",
);

pinned("@accountability/evidence-sql", "Evidence-Storage-and-Provenance-Engine", "dce7105a70b42d77afe4cd48d34723331447037c");
console.log("Stable persistence SDK pinned for OWN Factual operational DB");

pinned("@accountability/identity-policy", "Identity-Authorization-and-Policy-Engine", "763060ddc840979b56483afd830f78679a2369b0");
console.log("Accepted Identity resource policy pin retained");
