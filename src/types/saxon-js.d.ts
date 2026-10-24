declare module "saxon-js" {
  interface TransformOptions {
    stylesheetFileName?: string;
    stylesheetText?: string;
    sourceText?: string;
    destination?: "serialized" | "raw" | "document";
  }
  interface TransformResult {
    principalResult: string;
  }
  const SaxonJS: {
    transform(options: TransformOptions, mode: "sync"): TransformResult;
    transform(options: TransformOptions, mode: "async"): Promise<TransformResult>;
  };
  export default SaxonJS;
}
