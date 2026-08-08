import type { Ticket } from "@orchestrator/types";

/**
 * TicketSource — interface for fetching tickets from a source.
 * Built-in implementations: GitHubTicketSource, LocalTicketSource.
 * Extensible to support new sources (Linear, Jira, etc.) later.
 */
export interface TicketSource {
  fetch(): Promise<Ticket[]>;
}
