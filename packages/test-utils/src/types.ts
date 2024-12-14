import { SourceMap, UnstructuredMetadata } from "@replay-cli/shared/recording/types";

// TODO [PRO-720] Delete this type.
export type RecordingEntry<TMetadata extends UnstructuredMetadata = UnstructuredMetadata> = {
  id: string;
  createTime: Date;
  runtime: string;
  metadata: TMetadata;
  sourcemaps: SourceMap[];
  buildId?: string;
  status:
    | "onDisk"
    | "unknown"
    | "uploaded"
    | "crashed"
    | "startedWrite"
    | "startedUpload"
    | "crashUploaded"
    | "unusable";
  path?: string;
  server?: string;
  recordingId?: string;
  crashData?: any[];
  unusableReason?: string;
};

export type UploadStatusThreshold = "all" | "failed-and-flaky" | "failed";

export type UploadOptions = {
  /**
   * Maximum number of recordings to upload (within a shard).
   */
  maximumLimit?: number;
  /**
   * Minimize the number of recordings uploaded for a test attempt (within a shard).
   * e.g. Only one recording would be uploaded for a failing test attempt, regardless of retries.
   * e.g. Two recordings would be uploaded for a flaky test attempt (the passing test and one of the failures).
   */
  minimizeUploads?: boolean;
  /**
   * Only upload recordings that meet the specified status threshold.
   * e.g. "all" (default) will upload all recordings
   * e.g. "failed-and-flaky" will only upload recordings for failed or flaky tests
   * e.g. "failed" will only upload recordings for failed tests
   */
  statusThreshold?: UploadStatusThreshold;
};

export interface ReplayReporterConfig<
  TRecordingMetadata extends UnstructuredMetadata = UnstructuredMetadata
> {
  runTitle?: string;
  metadata?: Record<string, any> | string;
  metadataKey?: string;
  upload?: UploadOptions | boolean;
  apiKey?: string;
  /** @deprecated Use `upload.minimizeUploads` and `upload.statusThreshold` instead */
  filter?: (r: RecordingEntry<TRecordingMetadata>) => boolean;
}
