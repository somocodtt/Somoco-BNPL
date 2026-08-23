import { useEffect, useState } from "react";

export interface CustomerPrivacyRequest {
  id: string;
  requestType: "ACCESS" | "CORRECTION" | "RESTRICTION";
  status: string;
  createdAt: string;
}

export interface CustomerPrivacyApi {
  listRequests(): Promise<readonly CustomerPrivacyRequest[]>;
  openRequest(input: {
    requestType: CustomerPrivacyRequest["requestType"];
    subjectType: "APPLICANT" | "GUARANTOR";
    reason?: string;
  }): Promise<CustomerPrivacyRequest>;
  exportRequest(requestId: string): Promise<Record<string, unknown>>;
}

export function PrivacyCenter({ api }: { api: CustomerPrivacyApi }) {
  const [requests, setRequests] = useState<readonly CustomerPrivacyRequest[]>(
    [],
  );
  const [requestType, setRequestType] =
    useState<CustomerPrivacyRequest["requestType"]>("ACCESS");
  const [message, setMessage] = useState("");

  async function refresh() {
    setRequests(await api.listRequests());
  }

  useEffect(() => {
    void refresh().catch(() =>
      setMessage("Privacy requests are temporarily unavailable."),
    );
  }, [api]);

  async function submit() {
    try {
      await api.openRequest({ requestType, subjectType: "APPLICANT" });
      setMessage("Your privacy request was recorded for compliance review.");
      await refresh();
    } catch {
      setMessage("We could not record the request. Please try again later.");
    }
  }

  return (
    <section aria-labelledby="privacy-title" className="privacy-center">
      <h2 id="privacy-title">Your privacy choices</h2>
      <p>
        Request access, correction, or restricted processing of your
        information.
      </p>
      <label>
        Request type
        <select
          value={requestType}
          onChange={(event) =>
            setRequestType(
              event.target.value as CustomerPrivacyRequest["requestType"],
            )
          }
        >
          <option value="ACCESS">Access my information</option>
          <option value="CORRECTION">Correct my information</option>
          <option value="RESTRICTION">Restrict processing</option>
        </select>
      </label>
      <button type="button" onClick={() => void submit()}>
        Submit privacy request
      </button>
      {message ? <p role="status">{message}</p> : null}
      <ul aria-label="Privacy requests">
        {requests.map((request) => (
          <li key={request.id}>
            {request.requestType}: {request.status}
            {request.requestType === "ACCESS" ? (
              <button
                type="button"
                onClick={() => void api.exportRequest(request.id)}
              >
                Download safe export
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
