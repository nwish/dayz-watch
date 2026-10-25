"""Collapse merged PR commits into one entry before git-cliff renders the notes.

Reads git-cliff JSON context on stdin, writes enriched context on stdout.
Requires GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY, and a full git checkout
at the release tag. API errors fail the run instead of producing duplicate notes.
"""
import json
import os
import subprocess
import sys
import urllib.request


def pull_requests(repository, sha):
    token = os.environ.get("GH_TOKEN") or os.environ["GITHUB_TOKEN"]
    results = []
    page = 1
    while True:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}/commits/{sha}/pulls?per_page=100&page={page}",
            headers={"Authorization": f"Bearer {token}",
                     "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            batch = json.load(response)
        results.extend(batch)
        if len(batch) < 100:
            return results
        page += 1


def reachable(sha):
    return bool(sha) and subprocess.run(
        ["git", "merge-base", "--is-ancestor", sha, "HEAD"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0


def combine(releases, repository, lookup=pull_requests, is_reachable=reachable):
    for release in releases:
        seen = set()
        entries = []
        for commit in release["commits"]:
            candidates = [pr for pr in lookup(repository, commit["id"])
                          if pr.get("merged_at") and pr["base"]["repo"]["full_name"] == repository
                          and is_reachable(pr.get("merge_commit_sha"))]
            # If a commit was reused in multiple PRs, credit its first merged PR.
            pr = min(candidates, key=lambda p: (p["merged_at"], p["number"])) if candidates else None
            commit["extra"] = {"repository": repository, "pr_number": None}
            if pr:
                if pr["number"] in seen:
                    continue
                seen.add(pr["number"])
                commit["message"] = pr["title"]
                commit["raw_message"] = pr["title"]
                commit["extra"]["pr_number"] = pr["number"]
            elif commit.get("merge_commit"):
                continue  # Branch-sync merges add no separate change.
            entries.append(commit)
        release["commits"] = entries
    return releases


if __name__ == "__main__":
    json.dump(combine(json.load(sys.stdin), os.environ["GITHUB_REPOSITORY"]), sys.stdout)
