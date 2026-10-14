// The S3 raw archive opened for reading (restores only: scripts/restoreNws.js). Kept apart from index.js so the
// Lambda bundles don't pull in the read credentials.
// The runtime user (AWS_PROFILE) may only write to the bucket, so this reads with AWS_DEPLOY_PROFILE from ~/.aws, as
// `npm run aws:deploy` does. It only lists and gets objects.

import { homedir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { config } from "../../config.js";
import { S3RawArchive } from "./s3RawArchive.js";

export function createRawArchiveReader() {
  const dir = join(homedir(), ".aws");
  const credentials = fromIni({ profile: config.aws.deployProfile, filepath: join(dir, "credentials"), configFilepath: join(dir, "config") });
  return new S3RawArchive({
    bucket: config.aws.rawArchiveBucket, region: config.aws.region, client: new S3Client({ region: config.aws.region, maxAttempts: 3, credentials }),
  });
}
