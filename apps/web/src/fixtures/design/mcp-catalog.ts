/**
 * Fixture of GET /mcp-catalog (U29, U31): the tools snapshots of the two catalog servers on main
 * (mcp/catalog/memory, mcp/catalog/helpdesk), copied so fixture mode shows real tool schemas.
 * Statuses mirror production today: the images are not public yet, so no digest.
 */
import type { McpCatalogServer } from '../../lib/api/types'

export const MCP_CATALOG: McpCatalogServer[] = [
  {
    "name": "memory",
    "version": 1,
    "ref": "memory@1",
    "status": "published",
    "image": "ghcr.io/devfellowship/itera-mcp-memory@sha256:9f2c1ab49f2c1ab49f2c1ab49f2c1ab49f2c1ab49f2c1ab49f2c1ab49f2c1ab4",
    "transport": "stdio",
    "capabilities": [
      "memory",
      "knowledge-graph"
    ],
    "description": "A knowledge graph (entities, relations, observations): the MCP reference memory server, wrapped as a fixture with a seed and a state export.",
    "license": "Apache-2.0 AND MIT",
    "upstream": {
      "repo": "https://github.com/modelcontextprotocol/servers",
      "path": "src/memory",
      "commit": "a40bc270fb5ece62673f8a1196f57116d885c5eb",
      "npm": "@modelcontextprotocol/server-memory@2026.8.31",
      "checked": "2026-10-12: repository not archived; last commit on src/memory 2026-10-10 (cc89b34); LICENSE = MIT to Apache-2.0 transition; the date-based npm line is deprecated in favour of 1.0.0 (published 2026-10-11, too new to pin)"
    },
    "tools": [
      {
        "name": "create_entities",
        "description": "Create multiple new entities in the knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {
            "entities": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "description": "The name of the entity"
                  },
                  "entityType": {
                    "type": "string",
                    "description": "The type of the entity"
                  },
                  "observations": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "An array of observation contents associated with the entity"
                  }
                },
                "required": [
                  "name",
                  "entityType",
                  "observations"
                ]
              }
            }
          },
          "required": [
            "entities"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "create_relations",
        "description": "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        "inputSchema": {
          "type": "object",
          "properties": {
            "relations": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "from": {
                    "type": "string",
                    "description": "The name of the entity where the relation starts"
                  },
                  "to": {
                    "type": "string",
                    "description": "The name of the entity where the relation ends"
                  },
                  "relationType": {
                    "type": "string",
                    "description": "The type of the relation"
                  }
                },
                "required": [
                  "from",
                  "to",
                  "relationType"
                ]
              }
            }
          },
          "required": [
            "relations"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "add_observations",
        "description": "Add new observations to existing entities in the knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {
            "observations": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "entityName": {
                    "type": "string",
                    "description": "The name of the entity to add the observations to"
                  },
                  "contents": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "An array of observation contents to add"
                  }
                },
                "required": [
                  "entityName",
                  "contents"
                ]
              }
            }
          },
          "required": [
            "observations"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "delete_entities",
        "description": "Delete multiple entities and their associated relations from the knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {
            "entityNames": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "An array of entity names to delete"
            }
          },
          "required": [
            "entityNames"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "delete_observations",
        "description": "Delete specific observations from entities in the knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {
            "deletions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "entityName": {
                    "type": "string",
                    "description": "The name of the entity containing the observations"
                  },
                  "observations": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "An array of observations to delete"
                  }
                },
                "required": [
                  "entityName",
                  "observations"
                ]
              }
            }
          },
          "required": [
            "deletions"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "delete_relations",
        "description": "Delete multiple relations from the knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {
            "relations": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "from": {
                    "type": "string",
                    "description": "The name of the entity where the relation starts"
                  },
                  "to": {
                    "type": "string",
                    "description": "The name of the entity where the relation ends"
                  },
                  "relationType": {
                    "type": "string",
                    "description": "The type of the relation"
                  }
                },
                "required": [
                  "from",
                  "to",
                  "relationType"
                ]
              },
              "description": "An array of relations to delete"
            }
          },
          "required": [
            "relations"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "read_graph",
        "description": "Read the entire knowledge graph",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "search_nodes",
        "description": "Search for nodes in the knowledge graph based on a query",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "The search query to match against entity names, types, and observation content"
            }
          },
          "required": [
            "query"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "open_nodes",
        "description": "Open specific nodes in the knowledge graph by their names",
        "inputSchema": {
          "type": "object",
          "properties": {
            "names": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "An array of entity names to retrieve"
            }
          },
          "required": [
            "names"
          ],
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      }
    ],
    "commit": "5c82cd8f1a2b3c4d5e6f708192a3b4c5d6e7f809",
    "syncedAt": "2026-10-12T21:00:00.000Z"
  },
  {
    "name": "helpdesk",
    "version": 1,
    "ref": "helpdesk@1",
    "status": "unpublished",
    "image": null,
    "transport": "http",
    "capabilities": [
      "helpdesk",
      "customer-support",
      "refunds",
      "tickets"
    ],
    "description": "A \u03c4-bench-style customer-support desk: customers, orders, tickets and refunds. A fixture: it simulates a service with seed data and never calls a real one.",
    "license": "Apache-2.0",
    "upstream": null,
    "tools": [
      {
        "name": "search_tickets",
        "description": "List support tickets. Filter by status (open or closed), by customer id, or by a text query on the subject and body. Returns the full ticket: id, customer_id, order_id, subject, body, status, resolution and notes.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "open",
                "closed"
              ]
            },
            "customer_id": {
              "type": "string",
              "maxLength": 20
            },
            "query": {
              "type": "string",
              "maxLength": 200
            }
          }
        }
      },
      {
        "name": "get_customer",
        "description": "Get one customer by id: name, email and tier.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "customer_id"
          ],
          "properties": {
            "customer_id": {
              "type": "string",
              "maxLength": 20
            }
          }
        }
      },
      {
        "name": "get_order",
        "description": "Get one order by id: items with unit prices in cents, total_cents, refunded_cents, status and delivered_at.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "order_id"
          ],
          "properties": {
            "order_id": {
              "type": "string",
              "maxLength": 20
            }
          }
        }
      },
      {
        "name": "issue_refund",
        "description": "Refund an amount in cents on an order, linked to a ticket. The amount must be positive and at most the order total minus what was already refunded. This moves money: it cannot be undone.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "order_id",
            "ticket_id",
            "amount_cents",
            "reason"
          ],
          "properties": {
            "order_id": {
              "type": "string",
              "maxLength": 20
            },
            "ticket_id": {
              "type": "string",
              "maxLength": 20
            },
            "amount_cents": {
              "type": "integer",
              "minimum": 1
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            }
          }
        }
      },
      {
        "name": "close_ticket",
        "description": "Close an open ticket with a resolution: refunded, denied, escalated or answered.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "ticket_id",
            "resolution"
          ],
          "properties": {
            "ticket_id": {
              "type": "string",
              "maxLength": 20
            },
            "resolution": {
              "type": "string",
              "enum": [
                "refunded",
                "denied",
                "escalated",
                "answered"
              ]
            }
          }
        }
      },
      {
        "name": "add_note",
        "description": "Add an internal note to a ticket (open or closed).",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "ticket_id",
            "text"
          ],
          "properties": {
            "ticket_id": {
              "type": "string",
              "maxLength": 20
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            }
          }
        }
      }
    ],
    "commit": "5c82cd8f1a2b3c4d5e6f708192a3b4c5d6e7f809",
    "syncedAt": "2026-10-12T21:00:00.000Z"
  }
]
