import { loadStore, maskPhone, parseArgv, resolveUser, saveStore } from "./store.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const USAGE = `用法：
  node tml-users.mjs list
  node tml-users.mjs remove --user <手机号|昵称>
  node tml-users.mjs set-default --user <手机号|昵称>
  node tml-users.mjs add --phone <手机号> --nickname <昵称> --userId <id> --loginsession <session>
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgv(rest);
  const store = await loadStore();

  if (cmd === "list") {
    const users = Object.entries(store.users).map(([phone, u]) => ({
      phone,
      phoneMasked: maskPhone(phone),
      nickname: u.nickname,
      isDefault: store.default === phone,
    }));
    console.log(JSON.stringify({ users }, null, 2));
    return;
  }

  if (cmd === "remove") {
    const t = resolveUser(store, args.user);
    delete store.users[t.phone];
    if (store.default === t.phone) {
      const phones = Object.keys(store.users);
      store.default = phones.length === 1 ? phones[0] : null;
    }
    await saveStore(store);
    console.log(JSON.stringify({ removed: { phone: t.phone, nickname: t.nickname } }));
    return;
  }

  if (cmd === "set-default") {
    const t = resolveUser(store, args.user);
    store.default = t.phone;
    await saveStore(store);
    console.log(JSON.stringify({ default: { phone: t.phone, nickname: t.nickname } }));
    return;
  }

  if (cmd === "add") {
    if (!args.phone || !args.userId || !args.loginsession) {
      throw new Error("add 需要 --phone --userId --loginsession，昵称可选 --nickname");
    }
    store.users[args.phone] = {
      nickname: args.nickname || args.phone,
      userId: args.userId,
      loginsession: args.loginsession,
    };
    if (!store.default || !store.users[store.default]) store.default = args.phone;
    await saveStore(store);
    console.log(JSON.stringify({ added: { phone: args.phone, nickname: store.users[args.phone].nickname } }));
    return;
  }

  throw new Error(`未知命令「${cmd}」\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
