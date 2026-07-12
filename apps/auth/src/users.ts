// User repository: the same admin GraphQL documents the .NET service used.

import { gql } from "./graphql.js";
import { config } from "./config.js";
import { generateHandle, generateSlug } from "./handles.js";

export interface User {
    user_id: string;
    username: string;
}

export async function getUser(username: string): Promise<User | null> {
    const data = await gql<{ user: User[] }>(
        `query GetUser($username: String!) {
            user(where: {username: {_eq: $username}}) { user_id username }
        }`,
        { username },
    );
    if (data.user.length > 1) throw new Error("multiple users for username");
    return data.user[0] ?? null;
}

export interface UserDetails extends User {
    email_address: string | null;
}

export async function getUserById(userId: string): Promise<UserDetails | null> {
    const data = await gql<{ user: UserDetails[] }>(
        `query GetUserById($user_id: uuid!) {
            user(where: {user_id: {_eq: $user_id}}) { user_id username email_address }
        }`,
        { user_id: userId },
    );
    return data.user[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
    const data = await gql<{ user: User[] }>(
        `query GetUserByEmail($email_address: String!) {
            user(where: {email_address: {_eq: $email_address}}) { user_id username }
        }`,
        { email_address: email },
    );
    if (data.user.length > 1) throw new Error("multiple users for email");
    return data.user[0] ?? null;
}

async function slugExists(slug: string): Promise<boolean> {
    const data = await gql<{ user: Array<{ user_id: string }> }>(
        `query GetUserBySlug($slug: String!) {
            user(where: {slug: {_eq: $slug}}) { user_id }
        }`,
        { slug },
    );
    return data.user.length > 0;
}

export async function createUser(
    username: string,
    email: string | null,
): Promise<void> {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) throw new Error("username required");
    const trimmedEmail = email?.trim() || null;

    // Opaque provider ids (e.g. legacy "auth0|...") and email addresses get a
    // friendly generated handle and display name — an email must not leak
    // into the public slug. Real usernames slugify directly.
    let slug: string;
    let greetingName: string | null = null;
    if (trimmedUsername.includes("|") || trimmedUsername.includes("@")) {
        let handle = generateHandle();
        while (await slugExists(handle.slug)) handle = generateHandle();
        slug = handle.slug;
        greetingName = handle.displayName;
    } else {
        slug = generateSlug(trimmedUsername);
    }

    await gql(
        `mutation CreateUser($username: String!, $email_address: String, $slug: String!, $greeting_name: String) {
            insert_user_one(object: {username: $username, email_address: $email_address, slug: $slug, greeting_name: $greeting_name}) {
                user_id
            }
        }`,
        {
            username: trimmedUsername,
            email_address: trimmedEmail,
            slug,
            greeting_name: greetingName,
        },
    );
}

export async function updateUserEmail(
    username: string,
    email: string,
): Promise<void> {
    await gql(
        `mutation UpdateUserEmail($username: String!, $email_address: String) {
            update_user(where: {username: {_eq: $username}}, _set: {email_address: $email_address}) {
                affected_rows
            }
        }`,
        { username, email_address: email.trim() },
    );
}

// Default role first (when configured), then the user's DB roles — the exact
// order the .NET UserRepository.GetRoles produced. Feeds both token types
// and /me.
export async function getRoles(userId: string): Promise<string[]> {
    const roles: string[] = [];
    if (config.jwt.addDefaultRole) roles.push(config.jwt.defaultRole);

    const data = await gql<{
        user: Array<{ user_roles: Array<{ role: { name: string } | null }> }>;
    }>(
        `query GetUserRoles($user_id: uuid!) {
            user(where: {user_id: {_eq: $user_id}}) {
                user_roles { role { name } }
            }
        }`,
        { user_id: userId },
    );
    const user = data.user[0];
    if (!user || data.user.length !== 1) {
        throw new Error(`expected exactly one user for id ${userId}`);
    }
    for (const userRole of user.user_roles) {
        if (userRole.role?.name) roles.push(userRole.role.name);
    }
    return roles;
}
