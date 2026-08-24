import { useEffect, useState } from "react";

export interface StaffPrivacyRequest {
  id: string;
  subjectId: string;
  requestType: "ACCESS" | "CORRECTION" | "RESTRICTION";
  status: string;
  createdAt: string;
}

export interface StaffPrivacyApi {
  listRequests(): Promise<readonly StaffPrivacyRequest[]>;
  review(requestId: string): Promise<StaffPrivacyRequest>;
  close(
    requestId: string,
    outcome?: "COMPLETED" | "REJECTED",
  ): Promise<StaffPrivacyRequest>;
}

export function PrivacyWorkspace({ api }: { api: StaffPrivacyApi }) {
  const [requests, setRequests] = useState<readonly StaffPrivacyRequest[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    setRequests(await api.listRequests());
  }

  useEffect(() => {
    void refresh().catch(() => setError("Privacy queue unavailable."));
  }, [api]);

  return (
    <section aria-labelledby="staff-privacy-title">
      <h2 id="staff-privacy-title">Privacy requests</h2>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {requests.map((request) => (
          <li key={request.id}>
            <span>
              {request.requestType} · {request.status} · {request.subjectId}
            </span>
            <button
              type="button"
              onClick={() => void api.review(request.id).then(refresh)}
            >
              Review
            </button>
            <button
              type="button"
              onClick={() =>
                void api.close(request.id, "COMPLETED").then(refresh)
              }
            >
              Close
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
