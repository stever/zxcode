// Admin GraphQL client against apps/api — same wire contract as the .NET
// GraphQlClient: POST {query, variables} with X-Hasura-Admin-Secret, throw on
// any errors in the envelope.

import { config } from "./config.js";

export async function gql<T>(
    query: string,
    variables: Record<string, unknown>,
): Promise<T> {
    const response = await fetch(config.graphql.endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Hasura-Admin-Secret": config.graphql.adminSecret,
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
        throw new Error(`graphql endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    if (body.data === undefined) throw new Error("graphql returned no data");
    return body.data;
}
