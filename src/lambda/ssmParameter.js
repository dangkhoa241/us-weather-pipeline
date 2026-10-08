// Read one SecureString from SSM Parameter Store (standard tier, AWS-managed key aws/ssm: no customer KMS key).
// Used by the Lambdas at cold start (Atlas connection string, Turnstile secret, HMAC key); values are never logged.

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { config } from "../config.js";

const NAME = /^\/weather-pipeline\/[A-Za-z0-9_.\/-]+$/;   // the role may read only this path

/** @param {{ client?: { send: Function } }} [options] client: injectable for tests */
export async function getSecureParameter(name, { client } = {}) {
  if (!NAME.test(name ?? "")) throw new Error("the SSM parameter name (e.g. MONGO_URI_SSM_PARAM) must be under /weather-pipeline/");
  const ssm = client ?? new SSMClient({ region: config.aws.region, maxAttempts: 3 });
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!out.Parameter?.Value) throw new Error(`SSM parameter ${name} is empty`);
    return out.Parameter.Value;
  } finally {
    if (!client) ssm.destroy();
  }
}
