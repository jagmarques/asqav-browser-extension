const esbuild = require("esbuild");

// Bundle each MV3 entry to dist/ minified, no maps
// Raw src stays in git; only dist ships in the store zip
const entries = ["background.js", "options.js"];
for (const name of entries) {
  esbuild.buildSync({
    entryPoints: [`src/${name}`],
    bundle: true,
    minify: true,
    legalComments: "none",
    sourcemap: false,
    target: "chrome120",
    outfile: `dist/${name}`,
  });
}
console.log(`built: ${entries.join(", ")}`);
