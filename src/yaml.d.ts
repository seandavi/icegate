// wrangler bundles *.yaml as text modules (wrangler.jsonc "rules").
declare module "*.yaml" {
  const text: string;
  export default text;
}
