using System.Diagnostics;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography.Xml;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Serilog;

namespace SteveR.Auth.Saml;

/// <summary>
/// Class for handling the Base64 encoded response from a SAML IdP server.
/// </summary>
/// <remarks></remarks>
public class SamlResponse
{
    private readonly X509Certificate2 _certificate;
    private readonly int _defaultExpirationMinutes;
    private readonly XmlDocument _xmlDoc;
    private readonly XmlNamespaceManager _xmlNameSpaceManager;

    /// <param name="certificate">X.509 certificate for verifying the XML content received.</param>
    /// <param name="defaultExpirationMinutes">Number of minutes used to expire token, by default.</param>
    /// <param name="base64Response">Base64 encoded response from SAML IdP server.</param>
    public SamlResponse(string certificate, int defaultExpirationMinutes, string base64Response)
    {
        // Log.Information("Base64:\n{0}", base64Response);

        // Decode the XML from base64.
        _xmlDoc = new XmlDocument {PreserveWhitespace = true, XmlResolver = null};
        _xmlDoc.LoadXml(new UTF8Encoding().GetString(Convert.FromBase64String(base64Response)));
        Log.Information("XML:\n{0}", GetFormattedXml(_xmlDoc));

        // NOTE: It may help to see the decoded XML above for the certificate supplied in the request.

        var certificateWithoutHeaderAndFooter = certificate
            .Replace("\\n","")
            .Replace("-----BEGIN CERTIFICATE-----", "") 
            .Replace("-----END CERTIFICATE-----", "");

        var certificateBytes = Convert.FromBase64String(certificateWithoutHeaderAndFooter);
        _certificate = new X509Certificate2(certificateBytes);

        // Initialise the XmlNamespaceManager instance used when handling the XML document.
        _xmlNameSpaceManager = new XmlNamespaceManager(_xmlDoc.NameTable);
        _xmlNameSpaceManager.AddNamespace("ds", SignedXml.XmlDsigNamespaceUrl);
        _xmlNameSpaceManager.AddNamespace("saml", "urn:oasis:names:tc:SAML:2.0:assertion");
        _xmlNameSpaceManager.AddNamespace("samlp", "urn:oasis:names:tc:SAML:2.0:protocol");

        _defaultExpirationMinutes = defaultExpirationMinutes;
    }

    /// <summary>
    /// Validates the SAML response.
    /// </summary>
    /// <param name="err">Error message when not valid, otherwise null.</param>
    /// <returns>True if the SAML passes validation tests, otherwise false.</returns>
    public bool IsValid(out string? err)
    {
        if (!ValidateTimestampAssertions())
        {
            err = "Timestamp assertion validation failed";
            return false;
        }

        // NOTE: Response must have one and only one signature.
        var nodeList = _xmlDoc.SelectNodes("//ds:Signature", _xmlNameSpaceManager);

        if (nodeList == null)
        {
            throw new InvalidOperationException();
        }
        
        switch (nodeList.Count)
        {
            case 0:
                err = "No signature";
                return false;
            case 1:
                break;
            default:
                err = "More than one signature found";
                return false;
        }

        var signedXml = new SignedXml(_xmlDoc);
        signedXml.LoadXml((XmlElement)nodeList[0]!);

        if (!ValidateSignatureReference(signedXml))
        {
            err = "Signature reference validation failed";
            return false;
        }

        if (!signedXml.CheckSignature(_certificate, true))
        {
            err = "Signature validation failed";
            return false;
        }

        err = null;
        return true;
    }

    /// <summary>
    /// This method can be used to check the type of the SAML response using the root element name.
    /// </summary>
    /// <returns>XML root element name.</returns>
    public string? GetRootElementName()
    {
        return _xmlDoc.SelectSingleNode("/*")?.Name;
    }

    /// <returns>Username provided in the SAML response.</returns>
    public string? GetUserNameId()
    {
        // Attempt to find the username in the SAML response. NOTE: This varies depending on the SAML IdP server used.
        var node = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:Subject/saml:NameID", _xmlNameSpaceManager);
        if (node == null) _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:AttributeStatement/saml:Attribute[@NameFormat='urn:oasis:names:tc:SAML:2.0:attrname-format:uri']/saml:AttributeValue", _xmlNameSpaceManager);
        if (node == null) _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:AttributeStatement/saml:Attribute[@Name='uid']/saml:AttributeValue", _xmlNameSpaceManager);
        return node?.InnerText;
    }

    /// <returns>Email address provided in the SAML response.</returns>
    public string? GetEmail()
    {
        // Try multiple common SAML attribute names for email
        var node = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:AttributeStatement/saml:Attribute[@Name='email']/saml:AttributeValue", _xmlNameSpaceManager);
        if (node == null) node = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:AttributeStatement/saml:Attribute[@Name='http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']/saml:AttributeValue", _xmlNameSpaceManager);
        if (node == null) node = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:Subject/saml:NameID[@Format='urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress']", _xmlNameSpaceManager);
        return node?.InnerText;
    }

    /// <returns>Session expiry time provided by @SessionNotOnOrAfter assertion.</returns>
    public DateTime GetSessionExpiry()
    {
        var node = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion[1]/saml:AuthnStatement[1]/@SessionNotOnOrAfter", _xmlNameSpaceManager);
        if (node != null) return DateTime.Parse(node.InnerText);
        
        Log.Warning("No expiration determined from response. " +
                    $"Using default value of {_defaultExpirationMinutes} minutes.");
        
        return DateTime.Now.AddMinutes(_defaultExpirationMinutes);
    }

    /// <summary>
    /// Validates the timestamp assertions to handle expired responses.
    /// </summary>
    /// <returns>True if the response has expired, otherwise false.</returns>
    /// <remarks>This reduces the risk of the authentication being replayed.</remarks>
    private bool ValidateTimestampAssertions()
    {
        // NOTE: Adding 1 second to deal with a small difference seen in practice.
        var now = DateTime.Now.AddSeconds(1);

        // Check NotBefore
        var notBeforeNode = _xmlDoc.SelectSingleNode(
            "/samlp:Response/saml:Assertion[1]/saml:Conditions[1]/@NotBefore", 
            _xmlNameSpaceManager);

        if (notBeforeNode == null)
        {
            throw new InvalidOperationException();
        }
        
        var notBefore = DateTime.Parse(notBeforeNode.InnerText);

        if (now < notBefore)
        {
            Log.Error($"Now: {now}; " +
                      $"NotBefore: {notBefore} ({notBeforeNode.InnerText}); " +
                      $"now < notBefore? {now < notBefore}");
            return false;
        }

        // Check NotOnOrAfter
        var notOnOrAfterNode = _xmlDoc.SelectSingleNode(
            "/samlp:Response/saml:Assertion[1]/saml:Conditions[1]/@NotOnOrAfter",
            _xmlNameSpaceManager);

        if (notOnOrAfterNode == null)
        {
            throw new InvalidOperationException();
        }
        
        var notOnOrAfter = DateTime.Parse(notOnOrAfterNode.InnerText);

        if (now >= notOnOrAfter)
        {
            Log.Error($"Now: {now}; " +
                      $"NotOnOrAfter: {notOnOrAfter} ({notOnOrAfterNode.InnerText}); " +
                      $"now >= notOnOrAfter? {now >= notOnOrAfter}");
            return false;
        }

        return true;
    }

    /// <param name="signedXml">Signed XML instance to validate.</param>
    /// <returns>True if valid, otherwise false.</returns>
    private bool ValidateSignatureReference(SignedXml signedXml)
    {
        if (signedXml.SignedInfo.References.Count != 1)
        {
            return false;
        }

        var reference = (Reference?)signedXml.SignedInfo.References[0];
        var id = reference?.Uri.Substring(1);
        var idElement = signedXml.GetIdElement(_xmlDoc, id);

        if (idElement == null)
        {
            throw new InvalidOperationException();
        }

        if (idElement.Equals(_xmlDoc.DocumentElement))
        {
            return true;
        }

        var assertionNode = _xmlDoc.SelectSingleNode("/samlp:Response/saml:Assertion", _xmlNameSpaceManager) as XmlElement;

        if (assertionNode == null)
        {
            throw new InvalidOperationException();
        }

        return assertionNode.Equals(idElement);
    }

    /// <returns>Formatted XML</returns>
    private static string GetFormattedXml(XmlNode xmlDoc)
    {
        return XDocument.Parse(xmlDoc.InnerXml).ToString();
    }
}