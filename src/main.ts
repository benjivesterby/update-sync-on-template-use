import { promises as fs } from 'fs'
import path from 'path'
import * as core from '@actions/core'
import * as github from '@actions/github'
import simpleGit from 'simple-git/promise'
import YAML from 'yaml'

interface Response {
  repositoryOwner: {
    repositories: {
      pageInfo: {
        hasNextPage: boolean
        endCursor?: string
      }
      nodes: Item[]
    }
  }
}
interface Item {
  name: string
  nameWithOwner: string
  url: string
  templateRepository: null | {
    name: string
    owner: {
      login: string
    }
  }
}

interface Group {
  group: GPE[]
}

interface GPE {
  files: File[],
  templates: string[]
  repos: string
}
interface File {
  source: string
  dest: string
}

async function run(): Promise<void> {
  try {
    /***************************************/
    /*           CONFIGURATION             */
    /***************************************/
    // Github Personal Access Token
    const token: string = core.getInput('token')

    const octokit = github.getOctokit(token, {
      previews: ['baptiste']
    })
    const { repo } = github.context

    // Ensure this is only running on the configured template repository
    const templateRepo = core.getInput('template_repo') || ''
    if (templateRepo !== repo.repo) {
      core.info(
        `This repository [${repo.repo}] is not the configured template repository [${templateRepo}]. Skipping.`
      )
      return
    }

    // Configured organization or the owner of the repository
    const org = core.getInput('org') || repo.owner

    // The name of the sync repository including organization
    const syncRepo = core.getInput('sync_repo')

    // const signingKey = core.getInput('signingKey') || ''

    const baseDir = path.join(process.cwd() || '')

    const sharedDir = path.join(
      baseDir,
      "shared",
    )

    const syncYmlPath = path.join(
      sharedDir,
      core.getInput('sync_file') || 'sync.yml',
    )

    // GIT Configuration Settings
    const authorEmail =
      core.getInput('author_email') || 'benji@devnw.com'
    const authorName = core.getInput('author_name') || repo.owner
    const user: string = core.getInput('user') || `benjivesterby`

    // Setup repository path for shared repository
    const sharedRepo = `https://${user}:${token}@github.com/${syncRepo}`

    /***************************************/
    /*             QUERY GITHUB            */
    /***************************************/

    // Query the Github API for all repositories that were
    // created with this template
    let items: Item[] = []
    let nextPageCursor: string | null | undefined = null

    do {
      const result: Response = await octokit.graphql(
        `
        query orgRepos($owner: String!, $afterCursor: String) {
      repositoryOwner(login: $owner) {
        repositories(first: 100, after: $afterCursor, orderBy: { field: CREATED_AT, direction: DESC }) {
              pageInfo {
            hasNextPage
            endCursor
          }
              nodes {
            name
            nameWithOwner
            url
                templateRepository {
              name
                  owner {
                login
              }
            }
          }
        }
      }
    }
      `,
        {
          owner: org,
          afterCursor: nextPageCursor
        }
      )
      nextPageCursor = result.repositoryOwner.repositories.pageInfo.hasNextPage
        ? result.repositoryOwner.repositories.pageInfo.endCursor
        : undefined

      items = items.concat(result.repositoryOwner.repositories.nodes)
    } while (nextPageCursor !== undefined)

    core.info(
      `Checking ${items.length} repositories for repositories from ${org} `
    )

    const reposProducedByThis = items
      .filter(
        d =>
          d.templateRepository &&
          d.templateRepository.name === repo.repo &&
          d.templateRepository.owner.login === org
      )
      .map(d => `${d.nameWithOwner}`)


    if (reposProducedByThis.length > 0) {
      core.info(`Found ${reposProducedByThis.length} repositories which match template ${repo.repo}`)

      const git = simpleGit(baseDir)

      try {
        await git.clone(sharedRepo, sharedDir)
      }
      catch (error: any) {
        core.setFailed(error.message)
      }

      // Load the configured sync file
      const syncYmlContent = await fs.readFile(syncYmlPath, {
        encoding: 'utf-8'
      })

      // Parse the YAML into JSON
      const sync: Group = await YAML.parseDocument(syncYmlContent).toJSON()

      reposProducedByThis.forEach(repo => {
        core.info(`Updating template ${syncRepo} configs and adding ${repo}`)

        // Iterate through the configurations and update the repositories list for
        // each configuration for this template
        let entries = 0
        for (let item in sync.group) {
          if (sync.group[item].templates.includes(syncRepo)) {
            if (!sync.group[item].repos.includes(repo)) {
              entries++
              sync.group[item].repos += `${repo}\n`
            }
          }
        }

        core.info(`Updated ${entries} configs for template ${syncRepo}`)
      });

      await fs.writeFile(syncYmlPath, YAML.stringify(sync))

      if (syncYmlContent !== YAML.stringify(sync)) {
        core.info('Changes found, committing')
        const git = simpleGit(sharedDir)
        await git.addConfig('user.email', authorEmail)
        await git.addConfig('user.name', authorName)
        await git.add(syncYmlPath)
        await git.commit(`new-repo: 🥷🏽 Updating list of repos to sync for template [${syncRepo}]`, undefined, {
          '--author': `"${authorName} <${authorEmail}>"`
        })
        await git.push()
      } else {
        core.info('No changes, skipping')
      }
    }
  } catch (error: any) {
    core.setFailed(error.message)
  }
}

run()
