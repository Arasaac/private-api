const BugReport = require('../models/BugReport')
const axios = require('axios')
const logger = require('../utils/logger')
const emails = require('../emails')

// Helper to convert base64 image data URL to buffer and mimeType
const parseBase64Image = (dataurl) => {
  const matches = dataurl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
  if (!matches || matches.length !== 3) {
    throw new Error('Invalid base64 string')
  }
  return {
    mimeType: matches[1],
    buffer: Buffer.from(matches[2], 'base64'),
  }
}

// Upload file to Mattermost using native fetch & FormData
const uploadFile = async (buffer, fileName, mimeType, channelId) => {
  const formData = new FormData()
  const blob = new Blob([buffer], { type: mimeType })
  formData.append('files', blob, fileName)
  formData.append('channel_id', channelId)

  const response = await fetch(`${process.env.MATTERMOST_URL}/api/v4/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MATTERMOST_TOKEN}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const errorData = await response.json()
    throw new Error(
      `Mattermost File Upload Error: ${errorData.message || response.statusText}`,
    )
  }

  const data = await response.json()
  return data.file_infos[0].id
}

const create = async (req, res) => {
  logger.debug('EXEC create bugReportsController')

  const { app, activityName, description, screenshot, metadata } = req.body
  const { email, name } = req.user

  try {
    let channelId = process.env.MATTERMOST_CHANNEL_ID
    if (app) {
      const appChannelVar = `MATTERMOST_CHANNEL_ID_${app.toUpperCase()}`
      if (process.env[appChannelVar]) {
        channelId = process.env[appChannelVar]
      }
    }

    let fileIds = []

    // 1. Upload screenshot if available
    if (screenshot) {
      const { buffer, mimeType } = parseBase64Image(screenshot)
      const fileId = await uploadFile(
        buffer,
        `screenshot_${Date.now()}.jpg`,
        mimeType,
        channelId,
      )
      fileIds.push(fileId)
    }

    // 2. Construct Mattermost post message
    const userLine = `**User:** ${name} (${email})\n`
    const message =
      `### 🐛 New Bug Report: ARActivities\n` +
      userLine +
      `**Activity:** ${activityName}\n` +
      `**Language:** ${metadata.language}\n` +
      `**URL:** ${metadata.url}\n` +
      `**Browser:** ${metadata.userAgent}\n\n` +
      `**Description:**\n${description}`

    // 3. Create Mattermost post
    const postResponse = await fetch(
      `${process.env.MATTERMOST_URL}/api/v4/posts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MATTERMOST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel_id: channelId,
          message: message,
          file_ids: fileIds,
        }),
      },
    )

    if (!postResponse.ok) {
      const errorData = await postResponse.json()
      throw new Error(
        `Mattermost Post Error: ${errorData.message || postResponse.statusText}`,
      )
    }

    const postData = await postResponse.json()
    const postId = postData.id

    // 4. Save bug report mapping in MongoDB
    const bugReport = new BugReport({
      postId,
      userEmail: email,
      userName: name,
      activityName,
      description,
    })
    await bugReport.save()

    logger.info(
      `Successfully created bug report with Mattermost postId: ${postId} for ${email}`,
    )
    return res.status(201).json({ success: true, postId })
  } catch (error) {
    logger.error(`Error creating bug report: ${error.message}`)
    return res.status(500).json({ error: error.message })
  }
}

const webhook = async (req, res) => {
  logger.debug('EXEC webhook bugReportsController')

  const { token, root_id, text, user_id, user_name } = req.body

  // 1. Verify token to secure the webhook
  if (process.env.MATTERMOST_WEBHOOK_TOKEN) {
    const validTokens = process.env.MATTERMOST_WEBHOOK_TOKEN.split(',').map(
      (t) => t.trim(),
    )
    if (!validTokens.includes(token)) {
      logger.warn('Unauthorized Mattermost webhook call received')
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  // 2. We only care about replies, which have a root_id
  if (!root_id) {
    logger.debug('Ignoring root post webhook call')
    return res.status(200).json({ status: 'ignored' })
  }

  try {
    // 3. Find the original bug report
    const bugReport = await BugReport.findOne({ postId: root_id })
    if (!bugReport) {
      logger.warn(`No bug report found matching postId: ${root_id}`)
      return res.status(404).json({ error: 'Bug report not found' })
    }

    // 4. Fetch the replier details from Mattermost to get their email
    const mattermostUrl = process.env.MATTERMOST_URL
    const mattermostToken = process.env.MATTERMOST_TOKEN

    let replierEmail = ''
    let replierName = user_name

    try {
      const response = await axios.get(
        `${mattermostUrl}/api/v4/users/${user_id}`,
        {
          headers: {
            Authorization: `Bearer ${mattermostToken}`,
          },
        },
      )
      if (response.data) {
        replierEmail = response.data.email
        replierName = response.data.first_name
          ? `${response.data.first_name} ${response.data.last_name || ''}`.trim()
          : response.data.username
      }
    } catch (apiError) {
      logger.error(
        `Failed to fetch user info from Mattermost: ${apiError.message}`,
      )
    }

    // 5. Send email copy to the original writer, with CC to the replier
    if (bugReport.userEmail) {
      await emails.sendBugReportReplyMail({
        toEmail: bugReport.userEmail,
        toName: bugReport.userName || 'Usuario de ARASAAC',
        ccEmail: replierEmail,
        replyText: text,
        originalDescription: bugReport.description,
        activityName: bugReport.activityName,
      })
      logger.info(
        `Sent bug report reply email from ${replierEmail} to ${bugReport.userEmail}`,
      )
    } else {
      logger.warn(
        'Bug report has no associated user email, cannot send reply email',
      )
    }

    return res.status(200).json({ status: 'success' })
  } catch (error) {
    logger.error(`Error processing bug report reply webhook: ${error.message}`)
    return res.status(500).json({ error: error.message })
  }
}

module.exports = {
  create,
  webhook,
}
