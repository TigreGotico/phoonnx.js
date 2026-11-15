// tsup bundles .py files as text (see the loader in tsup.config.ts).
declare module "*.py" {
  const source: string;
  export default source;
}
