const BugReport = require('../models/BugReport')
const User = require('../models/User')
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

  try {
    let email = null
    let name = 'Usuario de ARASAAC'

    if (req.user && req.user.id) {
      try {
        const dbUser = await User.findById(req.user.id)
        if (dbUser) {
          email = dbUser.email
          name = dbUser.name
        }
      } catch (dbErr) {
        logger.error(`Error loading user from DB: ${dbErr.message}`)
      }
    }

    if (!email && metadata && metadata.user) {
      email = metadata.user.email
      name = metadata.user.name || name
    }

    if (!email) {
      return res.status(400).json({ error: 'User email is required' })
    }

    // Resolve channelId
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
    const message =
      `### 🐛 Nuevo Reporte de ARActivities\n\n` +
      `**👤 Usuario:** ${name}\n` +
      `**📧 Email:** ${email}\n` +
      `**🏷️ Actividad:** ${activityName}\n` +
      `**🌐 Idioma:** ${metadata.language}\n` +
      `**🔗 URL:** ${metadata.url}\n` +
      `**💻 Navegador:** ${metadata.userAgent}\n\n` +
      `**📝 Descripción:**\n${description}`

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
      fileIds: fileIds,
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

  const { token, root_id, post_id, text, user_id, user_name } = req.body

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

  let rootId = root_id

  // Mattermost Outgoing Webhooks do not send root_id directly in the payload.
  // We resolve it using the post_id by fetching the post details from Mattermost.
  if (!rootId && post_id) {
    try {
      const postResponse = await axios.get(
        `${process.env.MATTERMOST_URL}/api/v4/posts/${post_id}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.MATTERMOST_TOKEN}`,
          },
        },
      )
      if (postResponse.data && postResponse.data.root_id) {
        rootId = postResponse.data.root_id
      }
    } catch (err) {
      logger.error(
        `Error resolving root_id from post ${post_id}: ${err.message}`,
      )
    }
  }

  // 2. We only care about replies, which have a rootId
  if (!rootId) {
    logger.debug('Ignoring root post webhook call')
    return res.status(200).json({ status: 'ignored' })
  }

  try {
    // 3. Find the original bug report
    const bugReport = await BugReport.findOne({ postId: rootId })
    if (!bugReport) {
      logger.warn(`No bug report found matching postId: ${rootId}`)
      return res.status(404).json({ error: 'Bug report not found' })
    }

    const mattermostUrl = process.env.MATTERMOST_URL
    const mattermostToken = process.env.MATTERMOST_TOKEN

    // 4. Fetch the entire thread from Mattermost to construct conversation history
    let conversation = []
    let replierEmail = ''
    try {
      const threadResponse = await axios.get(
        `${mattermostUrl}/api/v4/posts/${rootId}/thread`,
        {
          headers: {
            Authorization: `Bearer ${mattermostToken}`,
          },
        },
      )

      if (
        threadResponse.data &&
        threadResponse.data.order &&
        threadResponse.data.posts
      ) {
        // Fetch user profiles for all unique userIds in the thread
        const userIds = [
          ...new Set(
            Object.values(threadResponse.data.posts).map((p) => p.user_id),
          ),
        ]
        const userMap = {}

        await Promise.all(
          userIds.map(async (id) => {
            try {
              const userRes = await axios.get(
                `${mattermostUrl}/api/v4/users/${id}`,
                {
                  headers: {
                    Authorization: `Bearer ${mattermostToken}`,
                  },
                },
              )
              userMap[id] = userRes.data.first_name
                ? `${userRes.data.first_name} ${userRes.data.last_name || ''}`.trim()
                : userRes.data.username

              if (id === user_id) {
                replierEmail = userRes.data.email
              }
            } catch (err) {
              logger.error(`Error fetching user ${id}: ${err.message}`)
              userMap[id] = id === user_id ? user_name : 'Usuario'
            }
          }),
        )

        // Order the conversation chronologically (Mattermost returns newest first)
        conversation = threadResponse.data.order
          .slice()
          .reverse()
          .map((postId) => {
            const post = threadResponse.data.posts[postId]
            return {
              author: userMap[post.user_id] || 'Usuario',
              text: post.message,
              date: new Date(post.create_at).toLocaleString('es-ES'),
            }
          })
      }
    } catch (threadError) {
      logger.error(
        `Error fetching thread from Mattermost: ${threadError.message}`,
      )
      // Fallback if thread fetch fails
      conversation = [
        {
          author: user_name,
          text: text,
          date: new Date().toLocaleString('es-ES'),
        },
      ]
    }

    // 5. Download attachments if the original report had screenshots
    const attachments = []
    if (bugReport.fileIds && bugReport.fileIds.length > 0) {
      for (const fileId of bugReport.fileIds) {
        try {
          const fileResponse = await axios.get(
            `${mattermostUrl}/api/v4/files/${fileId}`,
            {
              headers: {
                Authorization: `Bearer ${mattermostToken}`,
              },
              responseType: 'arraybuffer',
            },
          )
          attachments.push({
            filename: `screenshot_${fileId}.jpg`,
            content: Buffer.from(fileResponse.data),
          })
        } catch (fileErr) {
          logger.error(
            `Error downloading file ${fileId} from Mattermost: ${fileErr.message}`,
          )
        }
      }
    }

    // 6. Send email copy to the original writer, with CC to the replier
    if (bugReport.userEmail) {
      await emails.sendBugReportReplyMail({
        toEmail: bugReport.userEmail,
        toName: bugReport.userName || 'Usuario de ARASAAC',
        ccEmail: replierEmail,
        replyText: text,
        originalDescription: bugReport.description,
        activityName: bugReport.activityName,
        conversation,
        attachments,
      })
      logger.info(
        `Sent bug report reply email from ${replierEmail} to ${bugReport.userEmail} with ${attachments.length} attachments`,
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
