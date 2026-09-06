import React, { useEffect, useState } from "react";

type Occurrence = {
  series_id: string;
  title: string;
  start: string;
  team_ids: string[];
};

export default function App() {
  const [events, setEvents] = useState<Occurrence[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const teamId =
    new URLSearchParams(window.location.search).get("team") || "team-a";

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/events?ids=${encodeURIComponent(teamId)}&days=30`,
        );
        const data = await res.json();
        setEvents(data.occurrences || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [teamId]);

  async function mark(eventId: string, occurrenceStart: string, status: string) {
    const respondentName = name.trim();
    if (!respondentName) {
      alert("Enter your name first.");
      return;
    }

    await fetch(`/api/events/${encodeURIComponent(eventId)}/attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: `web:${respondentName.toLowerCase()}`,
        user_name: respondentName,
        occurrence_start: occurrenceStart,
        status,
      }),
    });
    alert("Recorded: " + status);
  }

  return (
    <div style={{ padding: 24, fontFamily: "Arial, sans-serif" }}>
      <h1>Slack Club — Attendance Admin</h1>
      <p>
        Viewing events for <strong>{teamId}</strong>
      </p>
      <label>
        Your name{" "}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
        />
      </label>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div>
          {events.length === 0 ? (
            <p>No upcoming events.</p>
          ) : (
            <ul>
              {events.map((e) => (
                <li
                  key={`${e.series_id}:${e.start}`}
                  style={{ marginBottom: 12 }}
                >
                  <strong>{e.title}</strong> —{" "}
                  {new Date(e.start).toLocaleString()}
                  <div style={{ marginTop: 6 }}>
                    <button onClick={() => mark(e.series_id, e.start, "yes")}>
                      Yes
                    </button>{" "}
                    <button onClick={() => mark(e.series_id, e.start, "no")}>
                      No
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
