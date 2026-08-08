import type { CredentialSource } from "../domain/storage.js";

export class EnvironmentCredentialSource implements CredentialSource {
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  public get(reference: string): string | undefined {
    const value = this.#environment[reference]?.trim();
    return value === "" ? undefined : value;
  }
}
