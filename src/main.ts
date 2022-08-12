import * as core from '@actions/core'
import {updateIssueStatus} from './update-issue-status'

updateIssueStatus()
  .catch(err => {
    core.setFailed(err.message)
    process.exit(1)
  })
  .then(() => {
    process.exit(0)
  })
