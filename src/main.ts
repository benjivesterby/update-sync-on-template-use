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
  id: string
  repos: string
}
interface File {
  source: string
  dest: string
}

async function run(): Promise<void> {
  try {
    const authorEmail =
      core.getInput('author_email') || 'benji@devnw.com'
    const authorName = core.getInput('author_name') || 'Benji Vesterby'
    const baseDir = path.join(process.cwd(), core.getInput('cwd') || '')

    const token: string = core.getInput('token')
    const user: string = core.getInput('user') || `benjivesterby`
    const repository: string = `github.com/contrast-security-inc/go-shared.git` // core.getInput('repo') || 

    const sharedRepo = `https://${user}:${token}@${repository}`
    const sharedDir = path.join(
      baseDir,
      "shared",
    )

    core.info(
      `Base Directory: ${baseDir}\n
       Shared Repo: ${repository}\n
       Shared Directory: ${sharedDir}\n
      `
    )

    const syncYmlPath = path.join(
      sharedDir,
      core.getInput('syncFile') || 'sync.yml',
    )

    const octokit = github.getOctokit(token, {
      previews: ['baptiste']
    })
    const { repo } = github.context
    const org = core.getInput('org') || repo.owner
    const repoName = core.getInput('repo') || repo.repo
    // const signingKey = core.getInput('signingKey') || ''

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
      `Checking ${items.length} repositories for repositories from ${repoName} `
    )

    const reposProducedByThis = items
      .filter(
        d =>
          d.templateRepository &&
          d.templateRepository.name === repoName &&
          d.templateRepository.owner.login === org
      )
      .map(d => `[${d.nameWithOwner}](${d.url})`)

    const output = `${reposProducedByThis.join('\n* ')} `


    const git = simpleGit(baseDir)

    try {
      await git.clone(sharedRepo, sharedDir)
    }
    catch (error: any) {
      core.setFailed(error.message)
    }

    core.info(`base directory files`)
    await fs.readdir(baseDir, { withFileTypes: true })
      .then(files => {
        for (const file of files) {
          core.info(`Base Directory: Checking ${file.name}`)
        }
      })

    core.info(`shared directory files`)
    await fs.readdir(sharedDir, { withFileTypes: true })
      .then(files => {
        for (const file of files) {
          core.info(`Shared Directory: Checking ${file.name}`)
        }
      })

    const syncYmlContent = await fs.readFile(syncYmlPath, {
      encoding: 'utf-8'
    })

    const sync: Group = await YAML.parseDocument(syncYmlContent).toJSON()

    // core.info(sync.contents || 'no contents')
    // await core.info(JSON.stringify(sync) || 'no contents')

    // let item: GPE | undefined
    const toAdd: string = "Contrast-Security-Inc/net"

    for (let item in sync.group) {
      if (sync.group[item].id === "default") {
        if (!sync.group[item].repos.includes(toAdd)) {
          core.info(`Updating ${sync.group[item].id} and adding ${toAdd}`)
          sync.group[item].repos += `${toAdd}\n`
        }
      }
    }


    core.info(`Edited ${JSON.stringify(sync)}`)

    // await sync((grp: any) => {
    //   core.info(`${grp.repos}`)
    // });

    // const updatedReadme = syncYmlContent.replace(
    //   /# Template Repos Start[\s\S]+# Template Repos Stop/,
    //   `< !--TEMPLATE_LIST_START -->\n${ output } \n < !--TEMPLATE_LIST_END --> `
    // )

    await fs.writeFile(syncYmlPath, YAML.stringify(sync))

    if (syncYmlContent !== YAML.stringify(sync)) {
      core.info('Changes found, committing')
      await git.addConfig('user.email', authorEmail)
      await git.addConfig('user.name', authorName)
      await git.add(syncYmlPath)
      await git.commit(`docs: 📝 Updating template usage list`, undefined, {
        '--author': `"${authorName} <${authorEmail}>"`
      })
      await git.push()
      core.info('Committed')
    } else {
      core.info('No changes, skipping')
    }
  } catch (error: any) {
    core.setFailed(error.message)
  }
}

run()
