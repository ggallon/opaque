const sh = require("shelljs");
const path = require("path");

// throw if a command fails
sh.config.fatal = true;

const algo = ["ristretto", "p256", "p521"];

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
  algo.forEach(function (name) {
    if (name === "ristretto") {
      sh.exec("cargo build --target=wasm32-unknown-unknown --release");
    } else {
      sh.exec(
        `cargo build --target=wasm32-unknown-unknown --release --features ${name}`,
      );
    }
    sh.exec(
      `wasm-bindgen --out-dir=build/wbg_${name} --target=web --omit-default-module-path target/wasm32-unknown-unknown/release/opaque.wasm`,
    );
  });
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
  algo.forEach(function (name) {
    sh.cp("bin/templates/*", `build/wbg_${name}`);
  });

  // run tsc on our entry module wrapper
  algo.forEach(function (name) {
    tsc(`build/wbg_${name}/index.ts`);
  });

  // run rollup to bundle the js with wasm inlined and also bundle d.ts files
  algo.forEach(function (name) {
    rollup(name);
  });

  // write package json
  packageJson("opaque-wasm").to("build/ristretto/package.json");
  packageJson("opaque-p256-wasm").to("build/p256/package.json");
  packageJson("opaque-p521-wasm").to("build/p521/package.json");

  // create bin folder
  sh.mkdir("build/ristretto/bin", "build/p256/bin", "build/p521/bin");

  algo.forEach(function (name) {
    // write bin script
    bin.to(`build/${name}/bin/index.js`);
    sh.chmod("+x", `build/${name}/bin/index.js`);
    // copy docs
    sh.cp("README.md", `build/${name}/README.md`);
    sh.cp("LICENSE", `build/${name}/LICENSE`);
  });
}

main();
