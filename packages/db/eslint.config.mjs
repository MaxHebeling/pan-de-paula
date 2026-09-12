import base from "@pdp/config/eslint.base.mjs";
export default [...base, { files: ["scripts/**"], rules: { "no-console": "off" } }];
