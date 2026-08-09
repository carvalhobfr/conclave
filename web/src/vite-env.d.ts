declare module "*.css";

interface Window {
  readonly conclaveDesktop?: {
    pickRepository(): Promise<string | undefined>;
  };
}
