/**
 * OctoC2 Server — Proto definition inlined as a string constant.
 *
 * BeaconGrpcService writes this to a temp file so @grpc/proto-loader can
 * load it (proto-loader requires a file path, not a string).
 *
 * Source of truth: proto/svc.proto (keep in sync manually).
 */

export const PROTO_DEFINITION = `
syntax = "proto3";

package svc;

message BeaconInfo {
  string id           = 1;
  string hostname     = 2;
  string username     = 3;
  string os           = 4;
  string arch         = 5;
  int32  pid          = 6;
  string public_key   = 7;
  string first_seen   = 8;
  string last_seen    = 9;
  string status       = 10;
}

message Task {
  string id        = 1;
  string kind      = 2;
  string args_json = 3;
  string issued_at = 4;
  string ciphertext = 5;
  string nonce      = 6;
}

message TaskResult {
  string task_id      = 1;
  string beacon_id    = 2;
  bool   success      = 3;
  string output       = 4;
  string data         = 5;
  string completed_at = 6;
  string signature    = 7;
}

message CheckinRequest {
  string beacon_id  = 1;
  string public_key = 2;
  string hostname   = 3;
  string username   = 4;
  string os         = 5;
  string arch       = 6;
  int32  pid        = 7;
  string checkin_at = 8;
}

message CheckinResponse {
  repeated Task pending_tasks = 1;
  string operator_nonce     = 2;
  string operator_signature = 3;
}

message SubmitResultRequest {
  TaskResult result = 1;
}

message SubmitResultResponse {
  bool   accepted = 1;
  string message  = 2;
}

service BeaconService {
  rpc Checkin (CheckinRequest) returns (CheckinResponse);
  rpc SubmitResult (SubmitResultRequest) returns (SubmitResultResponse);
}

message ShellInput {
  string beacon_id = 1;
  bytes  data      = 2;
}

message ShellOutput {
  bytes  data      = 1;
  bool   exit      = 2;
  int32  exit_code = 3;
}
`;
