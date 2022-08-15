import * as core from '@actions/core'
import * as github from '@actions/github'

// TODO: Ensure this (and the Octokit client) works for non-github.com URLs, as well.
// https://github.com/orgs|users/<ownerName>/projects/<projectNumber>
const urlParse =
  /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/

interface ProjectNodeIDResponse {
  organization?: {
    projectV2: {
      id: string
    }
  }

  user?: {
    projectV2: {
      id: string
    }
  }
}

interface IssueStatusResponse {
  projectItems: {
    nodes: [
      {
        fieldValueByName: {
          field: {
            databaseId: string
          },
          name: string
        }
      }
    ]
  }
}

interface UpdateIssueStatusResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: {
      id: string
      fieldValueByName: {
        field: {
          databaseId: string 
        },
        name: string
      }
    }
  }
}

export async function updateIssueStatus(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})
  const newStatus = core.getInput('new-status', {required:true})
  const openStatus = core.getInput('open-status', {required:true})

  const octokit = github.getOctokit(ghToken)

  const issue = github.context.payload.issue ?? github.context.payload.pull_request
  const issueOwnerName = github.context.payload.repository?.owner.login
  const issueAssignees = github.context.payload.issue?.assignees

  // Ensure the issue is not already assigned
  if (Object.keys(issueAssignees).length === 0) {
    core.info(`Skipping issue ${issue?.number} because it is already assigned an owner`)
    return
  }

  core.debug(`Issue/PR owner: ${issueOwnerName}`)
  core.debug(`Issue Assignees: ${issueAssignees}`)
  core.debug(`Project URL: ${projectUrl}`)

  const urlMatch = projectUrl.match(urlParse)

  if (!urlMatch) {
    throw new Error(
      `Invalid project URL: ${projectUrl}. Project URL should match the format https://github.com/<orgs-or-users>/<ownerName>/projects/<projectNumber>`
    )
  }

  const projectOwnerName = urlMatch.groups?.ownerName
  const projectNumber = parseInt(urlMatch.groups?.projectNumber ?? '', 10)
  const ownerType = urlMatch.groups?.ownerType
  const ownerTypeQuery = mustGetOwnerTypeQuery(ownerType)

  core.debug(`Project owner: ${projectOwnerName}`)
  core.debug(`Project number: ${projectNumber}`)
  core.debug(`Project owner type: ${ownerType}`)

  // First, use the GraphQL API to request the project's node ID.
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($projectOwnerName: String!, $projectNumber: Int!) {
      ${ownerTypeQuery}(login: $projectOwnerName) {
        projectV2(number: $projectNumber) {
          id
        }
      }
    }`,
    {
      projectOwnerName,
      projectNumber
    }
  )

  const issueResp = await octokit.graphql<IssueStatusResponse>(
    `query issueStatus {
        projectItems (first:1, includeArchived:false) {
          nodes {
            fieldValueByName(name:"Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    databaseId
                  }
                }
                name
              }
            }
          }
        }
      }`,
    )

  const projectId = idResp[ownerTypeQuery]?.projectV2.id
  const contentId = issue?.node_id
  const issueStatus = issueResp?.projectItems.nodes[0].fieldValueByName.name
  const fieldId = issueResp?.projectItems.nodes[0].fieldValueByName.field.databaseId

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Content ID: ${contentId}`)
  core.debug(`Issue Status: ${issueStatus}`)
  core.debug(`Field ID: ${fieldId}`)

  // Ensure the issue is open
  if (issueStatus !== openStatus) {
    core.info(`Skipping issue ${issue?.number} because it is not in an open status`)
    return
  }

  // Next, use the GraphQL API to add the issue to the project.
  // Update the status of an item.

  const updResp = await octokit.graphql<UpdateIssueStatusResponse>(
    `mutation updateIssueStatus($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: {
        fieldId: $fieldId
        itemId: $contentId,
        projectId: $projectId
        value: $issueStatus
      }) {
        projectV2Item {
          id
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              field {
                ... on ProjectV2SingleSelectField {
                  databaseId
                }
              }
              name
            }
          }
        }
      }`,
      {
        input: {
          fieldId,
          contentId,
          projectId,
          issueStatus
        }
      }
    )


  core.setOutput('fieldName', updResp.updateProjectV2ItemFieldValue.projectV2Item.fieldValueByName.name)

}

export function mustGetOwnerTypeQuery(ownerType?: string): 'organization' | 'user' {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}
