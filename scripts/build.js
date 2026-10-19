const esbuild = require("esbuild");

// Bundle each MV3 entry minified, no maps
// Raw src stays in git; only dist ships in the store zip
const ENTRIES = ["background.js", "options.js"];

function build(outdir = "dist") {
  for (const name of ENTRIES) {
    esbuild.buildSync({
      entryPoints: [`src/${name}`],
      bundle: true,
      minify: true,
      legalComments: "none",
      sourcemap: false,
      target: "chrome120",
      outfile: `${outdir}/${name}`,
    });
  }
  return ENTRIES;
}

if (require.main === module) {
  const built = build(process.env.OUTDIR || "dist");
  console.log(`built: ${built.join(", ")}`);
}

module.exports = { build };
