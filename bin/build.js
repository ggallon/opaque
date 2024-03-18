const sh = require("shelljs");
const path = require("path");

// throw if a command fails
sh.config.fatal = true;

const ristrettoPackageJson = JSON.parse(
  sh
    .cat(path.join(__dirname, "..", "build", "ristretto", "package.json"))
    .toString(),
);

const packageJson = function (name) {
  return new sh.ShellString(`{
  "name": "@proactice/${name}",
  "description": "Secure password based client-server authentication without the server ever obtaining knowledge of the password. Implementation of the OPAQUE protocol.",
  "collaborators": [
    "Gwenaël Gallon <gwenael@proactice.co>"
  ],
  "version": "${ristrettoPackageJson.version}",
  "license": "MIT",
  "files": [
    "index.d.ts",
    "esm/index.js",
    "cjs/index.js"
  ],
  "module": "esm/index.js",
  "types": "index.d.ts",
  "main": "cjs/index.js",
  "browser": "esm/index.js",
  "bin": "./bin/index.js",
  "repository": "github:proactice/opaque-wasm",
  "publishConfig": {
    "provenance": true
  }
}\n`);
};

const bin = new sh.ShellString(`#!/usr/bin/env node
const opaque = require("..");
opaque.ready.then(() => {
  if (process.argv[process.argv.length - 1] === "create-server-setup") {
    console.log(opaque.server.createSetup());
  } else if (
    process.argv[process.argv.length - 1] === "get-server-public-key"
  ) {
    console.error("ERROR: missing argument <SERVER_SETUP>");
    process.exit(1);
  } else if (
    process.argv[process.argv.length - 2] === "get-server-public-key"
  ) {
    try {
      console.log(
        opaque.server.getPublicKey(process.argv[process.argv.length - 1])
      );
    } catch (err) {
      console.error("ERROR! Failed to extract public key.");
      console.error(err.message + "\\n");
      console.error("Did you supply a valid SERVER_SETUP string?");
      process.exit(1);
    }
  } else {
    console.error(
      "ERROR: missing argument <create-server-setup|get-server-public-key>"
    );
    process.exit(1);
  }
});
`);

function build_wbg() {
  sh.exec("cargo build --target=wasm32-unknown-unknown --release");
  sh.exec(
    "wasm-bindgen --out-dir=build/wbg_ristretto --target=web --omit-default-module-path target/wasm32-unknown-unknown/release/opaque.wasm",
  );
  sh.exec(
    "cargo build --target=wasm32-unknown-unknown --release --features p256",
  );
  sh.exec(
    "wasm-bindgen --out-dir=build/wbg_p256 --target=web --omit-default-module-path target/wasm32-unknown-unknown/release/opaque.wasm",
  );
  sh.exec(
    "cargo build --target=wasm32-unknown-unknown --release --features p521",
  );
  sh.exec(
    "wasm-bindgen --out-dir=build/wbg_p521 --target=web --omit-default-module-path target/wasm32-unknown-unknown/release/opaque.wasm",
  );
}

function rollup(name) {
  sh.exec("pnpm rollup -c", {
    env: {
      ...process.env,
      BUILD_ENTRY: name,
    },
  });
}

function tsc(entry) {
  // Run tsc primarily to generate d.ts declaration files.
  // Our inputs are only ts files because we need to re-export types.
  // The target option is not that important because the result will be used as entry point for rollup.
  sh.exec(
    `pnpm tsc ${entry} --declaration --module es2020 --target es2020 --moduleResolution nodenext --removeComments`,
  );
}

function main() {
  sh.rm("-rf", "build");

  // build rust code and generate wasm bindings
  build_wbg();

  // copy wrapper module templates
  sh.cp("bin/templates/*", "build/wbg_ristretto");
  sh.cp("bin/templates/*", "build/wbg_p256");
  sh.cp("bin/templates/*", "build/wbg_p521");

  // run tsc on our entry module wrapper
  tsc("build/wbg_ristretto/index.ts");
  tsc("build/wbg_p256/index.ts");
  tsc("build/wbg_p521/index.ts");

  // run rollup to bundle the js with wasm inlined and also bundle d.ts files
  rollup("ristretto");
  rollup("p256");
  rollup("p521");

  // write package json
  packageJson("opaque-wasm").to("build/ristrettopackage.json");
  packageJson("opaque-p256-wasm").to("build/p256/package.json");
  packageJson("opaque-p521-wasme").to("build/p521/package.json");

  // create bin folder
  sh.mkdir(
    "build/ristrettobin",
    "build/p256/bin",
    "build/opaque-wasme-p521/bin",
  );

  // write bin script
  bin.to("build/ristrettobin/index.js");
  sh.chmod("+x", "build/ristrettobin/index.js");
  bin.to("build/p256/bin/index.js");
  sh.chmod("+x", "build/p256/bin/index.js");
  bin.to("build/p521/bin/index.js");
  sh.chmod("+x", "build/opaque-wasme-p521/bin/index.js");

  // copy docs
  sh.cp("README.md", "build/ristrettoREADME.md");
  sh.cp("README.md", "build/p256/README.md");
  sh.cp("README.md", "build/opaque-wasme-p521/README.md");
  sh.cp("LICENSE", "build/ristrettoLICENSE");
  sh.cp("LICENSE", "build/p256/LICENSE");
  sh.cp("LICENSE", "build/p521/LICENSE");
}

main();
