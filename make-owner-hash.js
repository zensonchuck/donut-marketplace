const crypto = require("crypto");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question(
  "Enter your owner password: ",
  password => {
    if (!password) {
      console.log(
        "Password cannot be empty."
      );

      rl.close();
      return;
    }

    const salt =
      crypto.randomBytes(32);

    const hash =
      crypto.scryptSync(
        password,
        salt,
        64,
        {
          N: 16384,
          r: 8,
          p: 1
        }
      );

    console.log("");
    console.log(
      "=========================================="
    );

    console.log(
      "OWNER_PASSWORD_HASH:"
    );

    console.log(
      `${salt.toString("hex")}:${hash.toString("hex")}`
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Copy ONLY the long hash above into Render."
    );

    rl.close();
  }
);
