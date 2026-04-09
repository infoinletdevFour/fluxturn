import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand, SendTemplatedEmailCommand, SESClientConfig } from '@aws-sdk/client-ses';
import { PlatformService } from '../database';
import { v4 as uuidv4 } from 'uuid';

export interface SESEmailOptions {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  template?: {
    name: string;
    data: Record<string, any>;
  };
  tags?: Array<{
    Name: string;
    Value: string;
  }>;
  configurationSetName?: string;
}

export interface SESEmailResponse {
  messageId: string;
  status: 'sent' | 'failed';
  error?: string;
  details?: any;
}

@Injectable()
export class SESService {
  private readonly logger = new Logger(SESService.name);
  private readonly sesClient: SESClient;
  private readonly defaultFrom: string;
  private readonly configurationSet?: string;

  constructor(
    private configService: ConfigService,
    private platformService: PlatformService
  ) {
    // Initialize AWS SES Client
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
    
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials are required for SES service. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
    }

    const sesConfig: SESClientConfig = {
      region: this.configService.get('AWS_REGION', 'us-east-1'),
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    };

    this.sesClient = new SESClient(sesConfig);
    this.defaultFrom = this.configService.get('EMAIL_DEFAULT_FROM', 'noreply@localhost');
    this.configurationSet = this.configService.get('SES_CONFIGURATION_SET');

    this.logger.log('SES Service initialized with region:', sesConfig.region);
  }

  /**
   * Send email directly via AWS SES
   */
  async sendEmail(
    options: SESEmailOptions,
    projectId?: string,
    appId?: string
  ): Promise<SESEmailResponse> {
    try {
      const from = options.from || this.defaultFrom;
      const toAddresses = this.normalizeAddresses(options.to);
      const ccAddresses = options.cc ? this.normalizeAddresses(options.cc) : undefined;
      const bccAddresses = options.bcc ? this.normalizeAddresses(options.bcc) : undefined;
      const replyToAddresses = options.replyTo ? this.normalizeAddresses(options.replyTo) : undefined;

      // Build SES send email command
      const command = new SendEmailCommand({
        Source: from,
        Destination: {
          ToAddresses: toAddresses,
          CcAddresses: ccAddresses,
          BccAddresses: bccAddresses,
        },
        ReplyToAddresses: replyToAddresses,
        Message: {
          Subject: {
            Data: options.subject,
            Charset: 'UTF-8',
          },
          Body: {
            Text: options.text ? {
              Data: options.text,
              Charset: 'UTF-8',
            } : undefined,
            Html: options.html ? {
              Data: options.html,
              Charset: 'UTF-8',
            } : undefined,
          },
        },
        Tags: options.tags,
        ConfigurationSetName: options.configurationSetName || this.configurationSet,
      });

      // Send email via SES
      const response = await this.sesClient.send(command);
      
      this.logger.log(`Email sent successfully via SES: ${options.subject} to ${toAddresses.join(', ')}`);
      this.logger.log(`SES Message ID: ${response.MessageId}`);

      // Log email to database
      await this.logEmail(
        projectId,
        appId,
        response.MessageId!,
        {
          from,
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject: options.subject,
          text: options.text,
          html: options.html,
        },
        'sent'
      );

      // Track usage for billing
      // Track usage if we have a projectId or appId
      if (projectId || appId) {
        await this.trackEmailUsage(projectId, appId, response.MessageId!, options);
      }

      return {
        messageId: response.MessageId!,
        status: 'sent',
        details: {
          from,
          to: toAddresses,
          subject: options.subject,
          timestamp: new Date().toISOString(),
          sesResponse: response,
        },
      };
    } catch (error) {
      this.logger.error('Failed to send email via SES:', error);
      
      // Log failed email
      const errorMessageId = this.generateId();
      await this.logEmail(
        projectId,
        appId,
        errorMessageId,
        {
          from: options.from || this.defaultFrom,
          to: this.normalizeAddresses(options.to),
          subject: options.subject,
        },
        'failed',
        undefined,
        error.message
      );

      return {
        messageId: errorMessageId,
        status: 'failed',
        error: error.message,
      };
    }
  }

  /**
   * Send templated email via AWS SES
   */
  async sendTemplatedEmail(
    templateName: string,
    templateData: Record<string, any>,
    options: Omit<SESEmailOptions, 'template' | 'subject' | 'text' | 'html'>,
    projectId?: string,
    appId?: string
  ): Promise<SESEmailResponse> {
    try {
      const from = options.from || this.defaultFrom;
      const toAddresses = this.normalizeAddresses(options.to);
      const ccAddresses = options.cc ? this.normalizeAddresses(options.cc) : undefined;
      const bccAddresses = options.bcc ? this.normalizeAddresses(options.bcc) : undefined;
      const replyToAddresses = options.replyTo ? this.normalizeAddresses(options.replyTo) : undefined;

      // Build SES send templated email command
      const command = new SendTemplatedEmailCommand({
        Source: from,
        Destination: {
          ToAddresses: toAddresses,
          CcAddresses: ccAddresses,
          BccAddresses: bccAddresses,
        },
        ReplyToAddresses: replyToAddresses,
        Template: templateName,
        TemplateData: JSON.stringify(templateData),
        Tags: options.tags,
        ConfigurationSetName: options.configurationSetName || this.configurationSet,
      });

      // Send templated email via SES
      const response = await this.sesClient.send(command);
      
      this.logger.log(`Templated email sent successfully via SES: template ${templateName} to ${toAddresses.join(', ')}`);
      this.logger.log(`SES Message ID: ${response.MessageId}`);

      // Log email to database
      await this.logEmail(
        projectId,
        appId,
        response.MessageId!,
        {
          from,
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject: `Template: ${templateName}`,
        },
        'sent',
        templateName
      );

      // Track usage for billing
      if (projectId || appId) {
        await this.trackEmailUsage(projectId, appId, response.MessageId!, {
          from,
          to: toAddresses,
          subject: `Template: ${templateName}`,
          template: { name: templateName, data: templateData },
        });
      }

      return {
        messageId: response.MessageId!,
        status: 'sent',
        details: {
          from,
          to: toAddresses,
          template: templateName,
          templateData,
          timestamp: new Date().toISOString(),
          sesResponse: response,
        },
      };
    } catch (error) {
      this.logger.error('Failed to send templated email via SES:', error);
      
      // Log failed email
      const errorMessageId = this.generateId();
      await this.logEmail(
        projectId,
        appId,
        errorMessageId,
        {
          from: options.from || this.defaultFrom,
          to: this.normalizeAddresses(options.to),
          subject: `Template: ${templateName}`,
        },
        'failed',
        templateName,
        error.message
      );

      return {
        messageId: errorMessageId,
        status: 'failed',
        error: error.message,
      };
    }
  }

  /**
   * Track email usage in database
   */
  private async trackEmailUsage(
    projectId?: string,
    appId?: string,
    messageId?: string,
    options?: Partial<SESEmailOptions> & { 
      subject: string; 
      template?: { name: string; data: Record<string, any>; };
    }
  ): Promise<void> {
    try {
      // Increment email usage for project or app
      if (projectId || appId) {
        await this.incrementEmailUsage(projectId, appId);
      }
    } catch (error) {
      this.logger.error('Failed to track email usage:', error);
    }
  }

  /**
   * Log email to database
   */
  private async logEmail(
    projectId?: string,
    appId?: string,
    messageId?: string,
    message?: {
      from: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      text?: string;
      html?: string;
    },
    status?: string,
    template?: string,
    error?: string
  ): Promise<void> {
    const id = this.generateId();

    // Log email if we have a projectId and message data
    if (projectId && message) {
      // Use raw SQL to log email
      await this.platformService.query(
        `INSERT INTO email_logs (
          id, project_id, message_id, "from", "to",
          cc, bcc, subject, status, template_id, error, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          id,
          projectId,
          messageId,
          message.from || this.defaultFrom,
          message.to,
          message.cc || null,
          message.bcc || null,
          message.subject || 'No Subject',
          status || 'sent',
          template || null,
          error || null,
          JSON.stringify({
            provider: 'aws-ses',
            text: message.text ? true : false,
            html: message.html ? true : false,
          }),
        ]
      );
    }
  }

  /**
   * Normalize email addresses to string array
   */
  private normalizeAddresses(addresses: string | string[]): string[] {
    return Array.isArray(addresses) ? addresses : [addresses];
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return uuidv4();
  }

  /**
   * Test SES connection
   */
  async testConnection(): Promise<boolean> {
    try {
      // Simple test by getting account sending enabled status
      const { GetAccountSendingEnabledCommand } = await import('@aws-sdk/client-ses');
      const command = new GetAccountSendingEnabledCommand({});
      await this.sesClient.send(command);
      return true;
    } catch (error) {
      this.logger.error('SES connection test failed:', error);
      return false;
    }
  }

  /**
   * Get SES configuration
   */
  getConfiguration(): {
    region: string;
    defaultFrom: string;
    hasCredentials: boolean;
    configurationSet?: string;
  } {
    return {
      region: this.configService.get('AWS_REGION', 'us-east-1'),
      defaultFrom: this.defaultFrom,
      hasCredentials: !!(
        this.configService.get('AWS_ACCESS_KEY_ID') &&
        this.configService.get('AWS_SECRET_ACCESS_KEY')
      ),
      configurationSet: this.configurationSet,
    };
  }

  /**
   * Increment email usage for project or app
   */
  private async incrementEmailUsage(projectId?: string, appId?: string): Promise<void> {
    try {
      const now = new Date();
      const month = new Date(now.getFullYear(), now.getMonth(), 1);

      if (appId) {
        // Update app usage
        await this.platformService.query(
          `INSERT INTO app_usage (app_id, email_count, month, updated_at)
           VALUES ($1, 1, $2, NOW())
           ON CONFLICT (app_id, month)
           DO UPDATE SET 
             email_count = app_usage.email_count + 1,
             updated_at = NOW()`,
          [appId, month]
        );
      } else if (projectId) {
        // Update project usage
        await this.platformService.query(
          `INSERT INTO project_usage (project_id, email_count, month, updated_at)
           VALUES ($1, 1, $2, NOW())
           ON CONFLICT (project_id, month)
           DO UPDATE SET 
             email_count = project_usage.email_count + 1,
             updated_at = NOW()`,
          [projectId, month]
        );
      }

      this.logger.debug(`Email usage tracked for ${appId ? `app ${appId}` : `project ${projectId}`}`);
    } catch (error) {
      this.logger.error('Failed to increment email usage:', error);
    }
  }
}