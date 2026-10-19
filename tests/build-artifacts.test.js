const { build } = require("../scripts/build");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Build-artifact gate: dist ships minified, map/host/secret-free
// Each assertion has a planted control that MUST fail when tripped
const ROOT = path.join(__dirname, "..");
const PRIVATE_HOST = /(hetzner|coolify|staging\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/;
const SECRET_SHAPE = /(sk_(live|test)_[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})/;

function readBundle(dir, name) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

function checkClean(label, dir) {
  for (const name of ["background.js", "options.js"]) {
    const code = readBundle(dir, name);
    expect(code).not.toMatch(/\/\*[\s\S]*?\*\//);
    expect(code).not.toMatch(PRIVATE_HOST);
    expect(code).not.toMatch(SECRET_SHAPE);
  }
  expect(fs.readdirSync(dir).some((f) => f.endsWith(".map"))).toBe(false);
}

function freshDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ext-${tag}-`));
}

test("dist bundles are minified, map-free and leak-free", () => {
  const dir = freshDir("dist");
  expect(build(dir)).toEqual(["background.js", "options.js"]);
  checkClean("dist", dir);
  const raw = fs.readFileSync(path.join(ROOT, "src", "background.js"), "utf8");
  const built = readBundle(dir, "background.js");
  expect(built.length).toBeLessThan(raw.length);
});

test("negative control: planted map fails the gate", () => {
  const dir = freshDir("neg");
  fs.writeFileSync(path.join(dir, "background.js"), "x=1");
  fs.writeFileSync(path.join(dir, "options.js"), "y=2");
  fs.writeFileSync(path.join(dir, "background.js.map"), "{}");
  expect(() => checkClean("planted-map", dir)).toThrow();
});

test("negative control: planted private host fails the gate", () => {
  const dir = freshDir("neg");
  fs.writeFileSync(path.join(dir, "background.js"), "fetch('https://db.coolify.local/x')");
  fs.writeFileSync(path.join(dir, "options.js"), "y=2");
  expect(() => checkClean("planted-host", dir)).toThrow();
});

test("negative control: planted secret fails the gate", () => {
  const dir = freshDir("neg");
  fs.writeFileSync(path.join(dir, "background.js"), "x=1");
  const probe = ["sk", "live"].join("_") + "_abcDEF1234567890";
  fs.writeFileSync(path.join(dir, "options.js"), `const k='${probe}';`);
  expect(() => checkClean("planted-secret", dir)).toThrow();
});
